/**
 * CEX feed fabrikası.
 *
 * Tek giriş noktası: hangi borsanın hangi sınıfa karşılık geldiğini bilen tek
 * yer burasıdır; çağıranlar somut sınıfları import etmez.
 */

import type { CexId, Feed } from '../../core/types.ts';
import type { PriceStore } from '../../book/price-store.ts';
import type { FeedMarket } from './base-feed.ts';

import { BinanceFeed } from './binance.ts';
import { BybitFeed } from './bybit.ts';
import { OkxFeed } from './okx.ts';
import { GateFeed } from './gate.ts';
import { MexcFeed } from './mexc.ts';
import { KucoinFeed } from './kucoin.ts';
import { KrakenFeed } from './kraken.ts';

export type { FeedMarket } from './base-feed.ts';

type FeedCtor = new (store: PriceStore, markets: readonly FeedMarket[]) => Feed;

const REGISTRY: Record<CexId, FeedCtor> = {
  binance: BinanceFeed,
  bybit: BybitFeed,
  okx: OkxFeed,
  gate: GateFeed,
  mexc: MexcFeed,
  kucoin: KucoinFeed,
  kraken: KrakenFeed,
};

export function createFeed(
  venue: CexId,
  store: PriceStore,
  markets: readonly FeedMarket[],
): Feed {
  return new REGISTRY[venue](store, markets);
}
