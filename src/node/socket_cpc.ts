import { createReaderFromReadable } from "#lib/node_stream_util.js";
import type { Duplex } from "node:stream";
import { StreamCpc } from "../cpc/stream_cpc.js";
import type { CpcCmdList, Cpc } from "../cpc/cpc.js";

/**
 * @remark
 * 依赖一个`Duplex`.
 * 如果 `duplex.writableEnded` || `duplex.readableEnded` || `duplex.destroyed` 为真，则 `Fcp`默认就是`closed`状态.
 * `duplex` 的`end`和`close`事件会触发 Fcp 的`close`
 *
 */
class CpcSocket<
    CallableCmd extends object = CpcCmdList,
    CmdList extends object = CpcCmdList,
    Dp extends Duplex = Duplex
> extends StreamCpc<CallableCmd, CmdList> {
    #duplex: Dp;
    get duplex() {
        return this.#duplex;
    }

    constructor(duplex: Dp) {
        super({
            read: createReaderFromReadable(duplex),
            write: (buf: ArrayBufferView) => {
                duplex.write(buf);
            },
            handshake: 5,
        });
        this.#duplex = duplex;
        if (duplex.destroyed || duplex.writableEnded || duplex.readableEnded) {
            this.finalEnd();
        }
        duplex.on("finish", () => this.end());
    }

    /** 最后的Fcp对象清理操作 */
    protected finalClose() {
        if (!this.#duplex.writableEnded) this.#duplex.end(() => this.#duplex.destroy());
        else this.#duplex.destroy();
        return super.finalClose();
    }
}
/**
 * @public
 * @param duplex - 如果 `duplex.writableEnded` || `duplex.readableEnded` || `duplex.destroyed` 为真，则 `Fcp`默认就是`closed`状态.
 * `duplex` 的`end`和`close`事件会触发 Fcp 的`close`
 */
export function createSocketCpc<CallableCmd extends object = CpcCmdList, CmdList extends object = CpcCmdList>(
    duplex: Duplex
): Cpc<CallableCmd, CmdList> {
    return new CpcSocket(duplex);
}
