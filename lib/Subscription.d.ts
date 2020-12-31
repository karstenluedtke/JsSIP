import {EventEmitter} from 'events'

import {UA} from './UA'
import {Transport} from './Transport'
import {ExtraHeaders, Originator, OutgoingListener, IncomingListener, IncomingInfoListener, EndedListener} from './RTCSession'

export interface SubscriptionEventMap {
  accepted: OutgoingListener;
  confirmed: IncomingInfoListener;
  notify: IncomingInfoListener;
  subscriptionExpiring: IncomingListener;
  ended: EndListener;
}

export interface SubscribeOptions extends ExtraHeaders {
  expires?: number;
  refresh?: boolean;
  eventHandlers?: Partial<SubscriptionEventMap>;
}

export class Subscription extends EventEmitter {
  constructor(ua: UA, target: string, event: string, transport: Transport);

  get id(): string;

  get state(): string;

  setExtraHeaders(extraHeaders: string[]): void;

  subscribe(options?: SubscribeOptions): void;

  unsubscribe(): void;

  on<T extends keyof SubscriptionEventMap>(type: T, listener: SubscriptionEventMap[T]): this;
}
