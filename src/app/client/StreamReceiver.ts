import { ManagerClient } from './ManagerClient';
import { ControlMessage } from '../controlMessage/ControlMessage';
import DeviceMessage from '../googDevice/DeviceMessage';
import VideoSettings from '../VideoSettings';
import ScreenInfo from '../ScreenInfo';
import Util from '../Util';
import { DisplayInfo } from '../DisplayInfo';
import { ParamsStream } from '../../types/ParamsStream';

const DEVICE_NAME_FIELD_LENGTH = 64;
const MAGIC_BYTES_INITIAL = Util.stringToUtf8ByteArray('scrcpy_initial');

export type ClientsStats = {
    deviceName: string;
    clientId: number;
};

export type DisplayCombinedInfo = {
    displayInfo: DisplayInfo;
    videoSettings?: VideoSettings;
    screenInfo?: ScreenInfo;
    connectionCount: number;
};

interface StreamReceiverEvents {
    video: ArrayBuffer;
    deviceMessage: DeviceMessage;
    displayInfo: DisplayCombinedInfo[];
    clientsStats: ClientsStats;
    encoders: string[];
    connected: void;
    disconnected: CloseEvent;
}

const TAG = '[StreamReceiver]';

export class StreamReceiver<P extends ParamsStream> extends ManagerClient<ParamsStream, StreamReceiverEvents> {
    private events: ControlMessage[] = [];
    private encodersSet: Set<string> = new Set<string>();
    private clientId = -1;
    private deviceName = '';
    private readonly displayInfoMap: Map<number, DisplayInfo> = new Map();
    private readonly connectionCountMap: Map<number, number> = new Map();
    private readonly screenInfoMap: Map<number, ScreenInfo> = new Map();
    private readonly videoSettingsMap: Map<number, VideoSettings> = new Map();
    private hasInitialInfo = false;
    private actionMaps: Map<number, any> = new Map();
    private action_time = "";
    private action_flag = false;

    constructor(params: P) {
        super(params);
        this.openNewConnection();
        if (this.ws) {
            this.ws.binaryType = 'arraybuffer';
        }
    }

    private handleInitialInfo(data: ArrayBuffer): void {
        let offset = MAGIC_BYTES_INITIAL.length;
        let nameBytes = new Uint8Array(data, offset, DEVICE_NAME_FIELD_LENGTH);
        offset += DEVICE_NAME_FIELD_LENGTH;
        let rest: Buffer = Buffer.from(new Uint8Array(data, offset));
        const displaysCount = rest.readInt32BE(0);
        this.displayInfoMap.clear();
        this.connectionCountMap.clear();
        this.screenInfoMap.clear();
        this.videoSettingsMap.clear();
        rest = rest.slice(4);
        for (let i = 0; i < displaysCount; i++) {
            const displayInfoBuffer = rest.slice(0, DisplayInfo.BUFFER_LENGTH);
            const displayInfo = DisplayInfo.fromBuffer(displayInfoBuffer);
            const { displayId } = displayInfo;
            this.displayInfoMap.set(displayId, displayInfo);
            rest = rest.slice(DisplayInfo.BUFFER_LENGTH);
            this.connectionCountMap.set(displayId, rest.readInt32BE(0));
            rest = rest.slice(4);
            const screenInfoBytesCount = rest.readInt32BE(0);
            rest = rest.slice(4);
            if (screenInfoBytesCount) {
                this.screenInfoMap.set(displayId, ScreenInfo.fromBuffer(rest.slice(0, screenInfoBytesCount)));
                rest = rest.slice(screenInfoBytesCount);
            }
            const videoSettingsBytesCount = rest.readInt32BE(0);
            rest = rest.slice(4);
            if (videoSettingsBytesCount) {
                this.videoSettingsMap.set(displayId, VideoSettings.fromBuffer(rest.slice(0, videoSettingsBytesCount)));
                rest = rest.slice(videoSettingsBytesCount);
            }
        }
        this.encodersSet.clear();
        const encodersCount = rest.readInt32BE(0);
        rest = rest.slice(4);
        for (let i = 0; i < encodersCount; i++) {
            const nameLength = rest.readInt32BE(0);
            rest = rest.slice(4);
            const nameBytes = rest.slice(0, nameLength);
            rest = rest.slice(nameLength);
            const name = Util.utf8ByteArrayToString(nameBytes);
            this.encodersSet.add(name);
        }
        this.clientId = rest.readInt32BE(0);
        nameBytes = Util.filterTrailingZeroes(nameBytes);
        this.deviceName = Util.utf8ByteArrayToString(nameBytes);
        this.hasInitialInfo = true;
        this.triggerInitialInfoEvents();
    }

    private static EqualArrays(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0, l = a.length; i < l; i++) {
            if (a[i] !== b[i]) {
                return false;
            }
        }
        return true;
    }

    protected buildDirectWebSocketUrl(): URL {
        const localUrl = super.buildDirectWebSocketUrl();
        if (this.supportMultiplexing()) {
            return localUrl;
        }
        localUrl.searchParams.set('udid', this.params.udid);
        return localUrl;
    }

    protected onSocketClose(ev: CloseEvent): void {
        console.log(`${TAG}. WS closed: ${ev.reason}`);
        this.emit('disconnected', ev);
    }

    protected onSocketMessage(event: MessageEvent): void {
        if (event.data instanceof ArrayBuffer) {
            // works only because MAGIC_BYTES_INITIAL and MAGIC_BYTES_MESSAGE have same length
            if (event.data.byteLength > MAGIC_BYTES_INITIAL.length) {
                const magicBytes = new Uint8Array(event.data, 0, MAGIC_BYTES_INITIAL.length);
                if (StreamReceiver.EqualArrays(magicBytes, MAGIC_BYTES_INITIAL)) {
                    this.handleInitialInfo(event.data);
                    return;
                }
                if (StreamReceiver.EqualArrays(magicBytes, DeviceMessage.MAGIC_BYTES_MESSAGE)) {
                    const message = DeviceMessage.fromBuffer(event.data);
                    this.emit('deviceMessage', message);
                    return;
                }
            }

            this.emit('video', new Uint8Array(event.data));
        }
    }

    protected onSocketOpen(): void {
        this.emit('connected', void 0);
        let e = this.events.shift();
        while (e) {
            this.sendEvent(e);
            e = this.events.shift();
        }
    }


    public async sendEvent(event: ControlMessage): Promise<void> {
        var actionMap = new Map();

        // 来提取窗口大小
        const entries = this.screenInfoMap.entries();
        let screenInfo;
        // 遍历 Map 的条目，来提取窗口大小
        for (let [, value] of entries) {
            // 从单个条目中提取 contentRect 和 videoSize
            screenInfo = { contentRect: value.contentRect }
            break; // 因为我们只需要第一个条目的值，所以提取后即可退出循环
        }

        // 添加返回的时间,窗口大小,设备名称
        const currentTime = Date.now()
        const action_json = {
            action_time: currentTime,
            ...event,
            ...screenInfo,
            device_name: this.deviceName
        };
        console.log(action_json)
        for (const [key, value] of Object.entries(action_json)) {
            actionMap.set(key, value)
        }

        this.actionMaps.set(currentTime, actionMap)

        // 对于不会影响 state 的 action，直接执行
        if ([4, 8, 9, 10, 101, 102].includes(action_json.type)) {
            this.sendActionEvent(event)
            this.sendAction(action_json, false)
            actionMap.set('executed', true)
            console.log("对于不会影响 state 的 action，直接执行")
            return;
        }

        // 判断是否是并发动作，如果是，则直接响应之前的
        // 需要判断现在的 this.action_time 是否 >= 并发的 action：
        // 如果没有，那就说明后端还没有给响应完，需要等待
        // 如果有，则直接响应之前的
        if (this.judgeConcurrency(actionMap)) {
            console.log("判断并发动作，前一个动作是：", this.getLastAction(actionMap))
            var lastNonConcurrencyAction = this.getLastNonConcurrencyAction(actionMap)
            console.log("并发动作，起始动作为：", lastNonConcurrencyAction)
            // while (lastNonConcurrencyAction.get('action_time') > this.action_time) {
            var executed = this.getLastAction(actionMap).has('executed')
            while (!executed) {
                await new Promise(resolve => setTimeout(resolve, 100));
                console.log("并发动作: " + actionMap.get('action_time') + ", 初始动作:" + lastNonConcurrencyAction.get('action_time') + ", executed:" + executed + ", 等待后端相应")
                executed = this.getLastAction(actionMap).has('executed')
                if (Date.now() - actionMap.get('action_time') > 3000) {
                    break
                }
            }

            if (this.getLastAction(actionMap).get('executed')) {
                this.sendActionEvent(event)
                this.sendActionConcurrency(action_json, true)
                actionMap.set('executed', true)
                console.log("并发动作，直接响应")
                return;
            }
            else {
                actionMap.set('executed', false)
                console.log("并发动作，直接不响应")
                return;
            }
        }

        // 对于非并发动作，判断和上一个动作间隔是否 > 最小动作时间间隔
        var lastExecutedAction = this.getLastExecutedAction(actionMap)
        if (actionMap.get('action_time') - lastExecutedAction.get('action_time') > 500) {
            // this.sendActionEvent(event)
            // this.sendAction(action_json, false)
            // actionMap.set('executed', true)
            // console.log("非并发动作，和上一个动作间隔 > 3s，执行")
            // return;

            // 给后端发送请求并等待响应
            await this.sendAction(action_json, false)

            // 非并发动作：根据后端响应，决定是否执行
            if (this.action_time == actionMap.get('action_time')) {
                if (this.action_flag == true) {
                    this.sendActionEvent(event)
                    actionMap.set('executed', true)
                    console.log("非并发动作，动作间隔 > 最小动作时间间隔，且后端空闲，执行")
                    return;
                }
                else {
                    actionMap.set('executed', false)
                    console.log("非并发动作，和上一个动作间隔 > 最小动作时间间隔，但后端忙碌，不执行")
                    return;
                }
            }

            // 非并发动作：后端没有正确响应，不执行
            actionMap.set('executed', false)
            console.log("非并发动作，后端死机，不执行")
            return;
        }

        console.log("非并发动作，和上一个动作间隔 < 最小动作时间间隔，不执行")
    }

    // 执行动作（原 sendEvent 中的代码）
    public sendActionEvent(event: ControlMessage): void {
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            this.ws.send(event.toBuffer());
        } else {
            this.events.push(event);
        }
    }

    // 判断是否是并发动作
    public judgeConcurrency(actionMap: Map<any, any>): boolean {
        const actionType = actionMap.get('type')
        var nonConcurrentType = [1, 4, 5, 6, 7, 8, 9, 10, 11, 101, 102]
        if (nonConcurrentType.includes(actionType)) {
            return false
        }

        if (actionType == 0) {
            if (actionMap.get('action') == 1) return true;
            else {
                let nonConcurrentKeyCode = [3, 4, 24, 25, 26, 187]
                if (nonConcurrentKeyCode.includes(actionMap.get('keycode'))) return false;
                else {
                    let lastAction = this.getLastAction(actionMap)
                    if (lastAction.get('type') == 0 && lastAction.get('action') == 0) return true;
                    else return false;
                }
            }
        }

        if (actionType == 2) {
            if (actionMap.get('action') == 0) return false;
            if (actionMap.get('action') == 1) return true;
            if (actionMap.get('action') == 2) return true;
        }

        if (actionType == 3) {
            if (this.getLastAction(actionMap).get('type') == 3) return true;
            else return false;
        }
        return false
    }

    // 获取上一步的 action，用于并发 action 
    public getLastAction(actionMap: Map<any, any>): Map<any, any> {
        var current_action_time = actionMap.get('action_time')
        var lastKey = 0

        for (const key of this.actionMaps.keys()) {
            if (key == current_action_time) break
            lastKey = key
        }

        return this.actionMaps.get(lastKey)
    }

    // 获取上一个执行了的 action，用于判断时间戳
    public getLastExecutedAction(actionMap: Map<any, any>): Map<any, any> {
        var current_action_time = actionMap.get('action_time')
        var lastExecutedKey = 0

        for (const key of this.actionMaps.keys()) {
            if (key == current_action_time) break
            if (this.actionMaps.get(key).get('executed')) {
                lastExecutedKey = key
            }
        }

        return this.actionMaps.get(lastExecutedKey)
    }

    // 获取并发 action 的起始非并发 action 
    public getLastNonConcurrencyAction(actionMap: Map<any, any>): Map<any, any> {
        var lastAction = this.getLastAction(actionMap)
        while (this.judgeConcurrency(lastAction)) {
            lastAction = this.getLastAction(lastAction)
        }
        return lastAction
    }

    // 发送 action 信息到后端（非并发的 action，需要修改 action_time, action_flag）
    // public sendAction(action_json: any, concurrency: boolean): void {
    public async sendAction(action_json: any, concurrency: boolean): Promise<void> {
        console.log("给后端发请求喽：", action_json)
        var action_json = {
            ...action_json,
            'concurrency': concurrency
        }
        var raw = JSON.stringify(action_json)
        var myHeaders = new Headers();
        myHeaders.append("Content-Type", "application/json");
        myHeaders.append("Accept", "*/*");

        var requestOptions = {
            method: 'POST',
            headers: myHeaders,
            body: raw
        };

        // await fetch("http://backend.cpolar.cn/action", requestOptions)
        await fetch("http://127.0.0.1:5000/action", requestOptions)
            // await fetch("http://earwig-apt-bug.ngrok-free.app", requestOptions)
            // .then(response => response.text())
            // .then(result => console.log(result))
            .then(response => response.json())
            .then(result => {
                console.log(result)
                this.action_flag = result['action_flag']
                this.action_time = result['action_time']
            })
            .catch(error => console.log('error', error));
    }

    // 发送 action 信息到后端（并发的 action）
    public sendActionConcurrency(action_json: any, concurrency: boolean): void {
        console.log("给后端发请求喽：", action_json)
        var action_json = {
            ...action_json,
            'concurrency': concurrency
        }
        var raw = JSON.stringify(action_json)
        var myHeaders = new Headers();
        myHeaders.append("Content-Type", "application/json");
        myHeaders.append("Accept", "*/*");

        var requestOptions = {
            method: 'POST',
            headers: myHeaders,
            body: raw
        };

        fetch("http://127.0.0.1:5000/action", requestOptions)
        // fetch("http://backend.cpolar.cn/action", requestOptions)
            // .then(response => console.log("response:", response.text()))
            .then(response => response.text())
            .then(result => console.log(result))
            .catch(error => console.log('error', error));
    }

    public stop(): void {
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            this.ws.close();
        }
        this.events.length = 0;
    }

    public getEncoders(): string[] {
        return Array.from(this.encodersSet.values());
    }

    public getDeviceName(): string {
        return this.deviceName;
    }

    public triggerInitialInfoEvents(): void {
        if (this.hasInitialInfo) {
            const encoders = this.getEncoders();
            this.emit('encoders', encoders);
            const { clientId, deviceName } = this;
            this.emit('clientsStats', { clientId, deviceName });
            const infoArray: DisplayCombinedInfo[] = [];
            this.displayInfoMap.forEach((displayInfo: DisplayInfo, displayId: number) => {
                const connectionCount = this.connectionCountMap.get(displayId) || 0;
                infoArray.push({
                    displayInfo,
                    videoSettings: this.videoSettingsMap.get(displayId),
                    screenInfo: this.screenInfoMap.get(displayId),
                    connectionCount,
                });
            });
            this.emit('displayInfo', infoArray);
        }
    }

    public getDisplayInfo(displayId: number): DisplayInfo | undefined {
        return this.displayInfoMap.get(displayId);
    }
}
