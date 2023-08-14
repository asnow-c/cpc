import { CpcCmdList, Cpc, CpcFrame } from "./cpc.js";
import { readCpcFrame, sendCpcFrame } from "../cpc/transition_frame.js";
import { DLD, numToDLD, type StreamReader, type StreamWriter } from "#lib/stream_util.js";

export interface CpcStreamCtrl {
    read: StreamReader;
    write: StreamWriter;
    handshake?: number;
}
export class StreamCpc<CallableCmd extends object = CpcCmdList, CmdList extends object = CpcCmdList> extends Cpc<
    CallableCmd,
    CmdList
> {
    #read: StreamReader;
    #write: StreamWriter;
    constructor(streamCtrl: CpcStreamCtrl) {
        super(2 ** 32 - 1);
        this.#read = streamCtrl.read;
        this.#write = streamCtrl.write;
        this.#start(streamCtrl.handshake).then(
            () => this.end(),
            (error) => this.dispose(error)
        );
    }
    async #start(handshake?: number) {
        if (handshake && handshake > 0) {
            this.#write(Buffer.alloc(handshake)); //HAND_SHAKE_LEN 个字节的 0, 握手机制, 确认连接
            if (!(await this.initCheck(handshake))) return;
        }
        return this.readFrame();
    }
    private async initCheck(handshake: number) {
        const read = this.#read;
        for (let i = 0; i < handshake; i++) {
            let buf = await read(1);
            if (buf[0] !== 0) {
                this.onCpcError(new Error("初始化失败"));
                this.dispose();
                return false;
            }
        }
        return true;
    }
    private async readFrame() {
        const read = this.#read;
        while (true) {
            const frameLen = await DLD.readNumber(read, true);
            if (frameLen === undefined) break;

            const frameBuf = await read(frameLen);
            const frame = readCpcFrame(frameBuf);
            this.onCpcFrame(frame);
        }
    }

    protected sendFrame(frame: CpcFrame) {
        const [chunks, totalLen] = sendCpcFrame(frame);
        this.#write(numToDLD(totalLen));
        for (let i = 0; i < chunks.length; i++) {
            this.#write(chunks[i]);
        }
    }
}