import {EventEmitter} from 'events'

import {UA} from './UA'
import {Transport} from './Transport'
import {ExtraHeaders} from './RTCSession'

export interface SubscribeOptions extends ExtraHeaders {
  expires?: number;
  refresh?: boolean;
  //eventHandlers?: Partial<MessageEventMap>;
}

export class Subscription extends EventEmitter {
  constructor(ua: UA, target: string, event: string, transport: Transport);

  setExtraHeaders(extraHeaders: string[]): void;

  subscribe(options?: SubscribeOptions): void;

  unsubscribe(): void;
}
