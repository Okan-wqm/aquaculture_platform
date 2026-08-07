/**
 * Ünite → yemleyici atama sorguları (CQRS).
 * @module FeedingProtocol/Queries
 */

/**
 * Bir ünitenin AKTİF yemleyicileri ve payları — sonraki fazın (öğün üretimi ve
 * mobil yemleme panosu) dozu bölmek için okuduğu yol.
 */
export class GetUnitFeederAssignmentsQuery {
  constructor(
    public readonly unitId: string,
    public readonly tenantId: string,
    /** Tarihçe (ENDED satırlar) da isteniyorsa true — izlenebilirlik okumaları. */
    public readonly includeEnded: boolean = false,
  ) {}
}
