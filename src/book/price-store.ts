/**
 * Allocation-free L1 fiyat deposu.
 *
 * Düzen: her (pair, venue) kombinasyonu bir "slot"tur ve tek bir düz
 * Float64Array'de FIELDS uzunluğunda bitişik alan kaplar. Tick işlemek
 * birkaç indeksli yazmaya iner — object yok, GC baskısı yok.
 *
 *   slot = pairIndex * venueCount + venueIndex
 *   offset = slot * FIELDS
 *
 * Slot indeksleri kurulum anında feed'lere dağıtılır, böylece hot path'te
 * string→index Map araması bile yapılmaz.
 */

import type { PairKey, VenueId } from '../core/types.ts';

const F_BID = 0;
const F_BID_QTY = 1;
const F_ASK = 2;
const F_ASK_QTY = 3;
const F_EXCHANGE_TS = 4;
const F_RECV_TS = 5;
const FIELDS = 6;

export class PriceStore {
  private readonly data: Float64Array;
  private readonly venueIndex = new Map<VenueId, number>();
  private readonly pairIndex = new Map<PairKey, number>();
  private readonly pairs: PairKey[];
  private readonly venues: VenueId[];

  /**
   * Venue başına son yazım anı (recvTs). Slotun kendi yaşı yalnızca O
   * sembolün L1'inin ne zaman DEĞİŞTİĞİNİ söyler; "değişince yayınlayan"
   * feed'lerde sakin bir defter canlı bağlantıda da yaşlanır. Venue'nun
   * genel olarak veri akıtıp akıtmadığı bu diziden okunur.
   */
  private readonly venueLastWrite: Float64Array;

  /** Bir tick geldiğinde dirty işaretlenen pair indeksleri. */
  private readonly dirty: Uint8Array;
  private dirtyList: number[] = [];

  constructor(pairs: readonly PairKey[], venues: readonly VenueId[]) {
    this.pairs = [...pairs];
    this.venues = [...venues];
    pairs.forEach((p, i) => this.pairIndex.set(p, i));
    venues.forEach((v, i) => this.venueIndex.set(v, i));

    this.data = new Float64Array(pairs.length * venues.length * FIELDS);
    this.dirty = new Uint8Array(pairs.length);
    this.venueLastWrite = new Float64Array(venues.length);
  }

  get pairCount(): number {
    return this.pairs.length;
  }

  get venueCount(): number {
    return this.venues.length;
  }

  pairAt(i: number): PairKey | undefined {
    return this.pairs[i];
  }

  venueAt(i: number): VenueId | undefined {
    return this.venues[i];
  }

  /**
   * Kurulum anında çağrılır. Feed adapter'ı dönen slot numarasını saklar ve
   * sonrasında yalnızca onu kullanır.
   * @returns slot indeksi, çift veya venue tanınmıyorsa -1
   */
  resolveSlot(pair: PairKey, venue: VenueId): number {
    const p = this.pairIndex.get(pair);
    const v = this.venueIndex.get(venue);
    if (p === undefined || v === undefined) return -1;
    return p * this.venues.length + v;
  }

  slotPairIndex(slot: number): number {
    return Math.floor(slot / this.venues.length);
  }

  slotVenue(slot: number): VenueId | undefined {
    return this.venues[slot % this.venues.length];
  }

  /** HOT PATH. Allocation yok, dal yok. */
  write(
    slot: number,
    bid: number,
    bidQty: number,
    ask: number,
    askQty: number,
    exchangeTs: number,
    recvTs: number,
  ): void {
    const o = slot * FIELDS;
    const d = this.data;
    d[o + F_BID] = bid;
    d[o + F_BID_QTY] = bidQty;
    d[o + F_ASK] = ask;
    d[o + F_ASK_QTY] = askQty;
    d[o + F_EXCHANGE_TS] = exchangeTs;
    d[o + F_RECV_TS] = recvTs;
    this.venueLastWrite[slot % this.venues.length] = recvTs;

    const pi = (slot / this.venues.length) | 0;
    if (this.dirty[pi] === 0) {
      this.dirty[pi] = 1;
      this.dirtyList.push(pi);
    }
  }

  bid(slot: number): number {
    return this.data[slot * FIELDS + F_BID]!;
  }
  bidQty(slot: number): number {
    return this.data[slot * FIELDS + F_BID_QTY]!;
  }
  ask(slot: number): number {
    return this.data[slot * FIELDS + F_ASK]!;
  }
  askQty(slot: number): number {
    return this.data[slot * FIELDS + F_ASK_QTY]!;
  }
  exchangeTs(slot: number): number {
    return this.data[slot * FIELDS + F_EXCHANGE_TS]!;
  }
  recvTs(slot: number): number {
    return this.data[slot * FIELDS + F_RECV_TS]!;
  }

  /** Venue'nun HERHANGİ bir slotuna son yazım anı; hiç yazılmadıysa 0. */
  venueLastWriteTs(venueIndex: number): number {
    return this.venueLastWrite[venueIndex]!;
  }

  /** Slot hiç veri almadıysa false. */
  hasData(slot: number): boolean {
    return this.data[slot * FIELDS + F_RECV_TS]! > 0;
  }

  /**
   * Son flush'tan bu yana güncellenmiş çift indekslerini döndürür ve dirty
   * işaretlerini temizler. Scanner bunu ~50ms'de bir çağırır: böylece tick
   * başına full tarama yerine yalnızca değişenler değerlendirilir.
   *
   * Dönen dizi çağıran tarafından tüketilmeli; bir sonraki flush'a kadar geçerlidir.
   */
  flushDirty(out: number[]): number[] {
    out.length = 0;
    const list = this.dirtyList;
    for (let i = 0; i < list.length; i++) {
      const pi = list[i]!;
      this.dirty[pi] = 0;
      out.push(pi);
    }
    list.length = 0;
    return out;
  }

  get dirtyCount(): number {
    return this.dirtyList.length;
  }
}
