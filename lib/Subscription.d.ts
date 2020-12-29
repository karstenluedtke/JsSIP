import {UA} from './UA'
import {Transport} from './Transport'

export class Subscription {
  constructor(ua: UA, target: string, event: string, transport: Transport);

  setExtraHeaders(extraHeaders: string[]): void;

  subscribe(): void;

  unsubscribe(): void;
}
