import { UniqueKeyMap } from "evlib/data_struct";
import { createEvent, withPromise, WithPromise } from "evlib";
import { PassiveDataCollector } from "evlib/async";
import { FrameType } from "../const.js";
import type { Frame, CalleeFrame, CallerFrame, RpcFrame } from "../type.js";

/** @internal */
export abstract class CalleeCommon {
  constructor(maxAsyncId = 4294967295) {
    this.#sendingUniqueKey = new UniqueKeyMap(maxAsyncId);
  }
  /** 等待返回给对方的 Promise 队列 */
  readonly #sendingUniqueKey: UniqueKeyMap;
  get promiseNum() {
    return this.#sendingUniqueKey.size;
  }
  /**
   * 1: 已发送 disable 帧
   * 2: 发送 disable 帧后所有异步返回均响应完成
   * */
  abstract readonly status: 0 | 1 | 2;

  /**
   * @throws 收到帧后必定会响应帧，这会调用 sendFrame. 如果 sendFrame 发生异常，则会抛出
   */
  onFrame(frame: RpcFrame): boolean;
  onFrame(chunk: CallerFrame) {
    switch (chunk[0]) {
      case FrameType.call:
        if (this.status > 0) return true; // 丢弃
        this.onCpcCall(chunk[1]);
        break;
      case FrameType.exec:
        if (this.status > 0) return true; // 丢弃
        this.onCpcExec(chunk[1]);
        break;
      case FrameType.end:
        if (this.status > 0) return true; // 丢弃
        this.onCpcEnd();
        break;
      default:
        return false;
    }
    return true;
  }
  protected abstract testClose(): void;
  protected abstract sendFrame(chunk: CalleeFrame): void;
  protected abstract onCpcCall(args: any[]): void;
  protected abstract onCpcExec(args: any[]): void;
  protected abstract onCpcEnd(): void;

  protected handelReturnPromise(pms: Promise<any>) {
    const id = this.#sendingUniqueKey.allowKeySet(pms);
    this.sendFrame([FrameType.promise, id]);
    return pms
      .then(
        (value) => [FrameType.resolve, id, value] as Frame.Resolve,
        (err) => [FrameType.reject, id, err] as Frame.Reject
      )
      .then((frame) => {
        this.#sendingUniqueKey.delete.bind(this, id);
        if (this.status === 2) return;
        try {
          this.sendFrame(frame);
        } catch (error) {}
        if (this.status === 1) this.testClose();
      });
  }
}

/** @internal */
export class CalleePassive extends CalleeCommon {
  constructor(
    protected sendFrame: (chunk: CalleeFrame) => void,
    public onCall: (...args: any[]) => any = voidFin,
    maxAsyncId?: number
  ) {
    super(maxAsyncId);
  }

  #fin: 0 | 1 | 2 = 0;
  get status() {
    return this.#fin;
  }
  /** status 变为 1 时触发 */
  $disable = createEvent<void>();
  /** status 变为 2 时触发 */
  $finish = createEvent<void>();
  /** 结束调用服务，发送 disable 帧 */
  disable(abort?: boolean): Promise<void> {
    if (this.#fin === 2) return Promise.resolve();
    let finishing = this.$finish();
    const emitClose = this.onCpcEnd();
    if (abort && !emitClose) this.emitFinish();
    return finishing;
  }
  protected testClose() {
    if (this.promiseNum === 0) {
      this.emitFinish();
      return true;
    }
  }
  protected onCpcExec(args: any[]) {
    try {
      const res = this.onCall.apply(undefined, args);
      if (res instanceof Promise) res.catch(voidFin);
    } catch (error) {}
  }
  protected onCpcCall(args: any[]) {
    let res;
    try {
      res = this.onCall.apply(undefined, args);
    } catch (error) {
      this.sendFrame([FrameType.throw, error] as Frame.Throw);
      return;
    }
    if (res instanceof Promise) this.handelReturnPromise(res);
    else this.sendFrame([FrameType.return, res] as Frame.Return);
  }
  protected onCpcEnd() {
    if (this.#fin !== 0) return;
    this.sendFrame([FrameType.disable] as Frame.Finish);
    this.emitDisable();
    return this.testClose();
  }
  private emitDisable() {
    this.#fin = 1;
    this.$disable.emit();
    this.$disable.close();
  }
  private emitFinish() {
    this.#fin = 2;
    this.$finish.emit();
    this.$finish.close();
  }
}

/** @internal */
export class CalleeActive extends CalleeCommon implements CpCallee {
  constructor(protected sendFrame: (chunk: CalleeFrame) => void, maxAsyncId?: number) {
    super(maxAsyncId);
  }

  #finished?: WithPromise<void, void> & { closed: boolean };
  get status() {
    if (!this.#finished) return 0;
    return this.#finished.closed ? 2 : 1;
  }
  protected testClose() {
    if (this.promiseNum === 0) {
      this.#finished!.closed = true;
      this.#finished!.resolve();
    }
  }

  private callAsyncLink = new PassiveDataCollector<any[], () => Promise<void>, any>();
  [Symbol.asyncIterator] = this.callAsyncLink.getAsyncGen;

  protected onCpcExec(args: any[]) {
    if (this.#finished) return true; // 丢弃
    this.callAsyncLink.yield(args).catch(() => {});
  }
  protected async onCpcCall(args: any[]) {
    if (this.#finished) return true; // 丢弃
    let res;
    try {
      res = await this.callAsyncLink.yield(args);
    } catch (error) {
      this.sendFrame([FrameType.throw, error] as Frame.Throw);
      return;
    }
    if (res instanceof Promise) this.handelReturnPromise(res);
    else this.sendFrame([FrameType.return, res] as Frame.Return);
  }
  protected onCpcEnd() {
    if (this.#finished) return;
    this.#finished = withPromise({ closed: false });

    this.sendFrame([FrameType.disable] as Frame.Finish);
    this.testClose();
    this.callAsyncLink.close(() => this.#finished!.promise);
  }
}

function voidFin() {}

interface CpCallee {
  /** 当前异步返回队列的数量 */
  readonly promiseNum: number;
  [Symbol.asyncIterator](): AsyncGenerator<any[], () => Promise<void>, any>;
}