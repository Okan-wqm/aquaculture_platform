/**
 * Update existing feeds with maxFishWeightG
 * Maps known feed codes to their max weight based on species weight ranges
 */
import { createGraphqlRequester } from './lib/graphql-http-client.mjs';

const TENANT_ID = 'ad6ca8fd-cdf7-4e6b-b68e-f17ad6484490';
const GRAPHQL_ENDPOINT =
  process.env.FEED_GRAPHQL_URL ?? process.env.GRAPHQL_URL ?? 'http://localhost:3000/graphql';
let TOKEN = '';

const gqlRequest = createGraphqlRequester({
  endpoint: GRAPHQL_ENDPOINT,
  tenantId: TENANT_ID,
  getToken: () => TOKEN,
});

async function login() {
  const data = await gqlRequest(`
    mutation Login($input: LoginInput!) {
      login(input: $input) { accessToken }
    }
  `, {
    input: { email: 'okan@suderra.com', password: '12345678' }
  });
  TOKEN = data.login.accessToken;
  console.log('Logged in.');
}

// Max weight mapping: code prefix -> maxFishWeightG
const MAX_WEIGHT_MAP = {
  // Wrasse 0-2g starters
  'SKR-WR-MICRO-01': 2,
  'BIO-WR-INICIO-03': 2,
  // Wrasse 2-10g fry
  'SKR-WR-WEAN-01': 10,
  'EWO-WR-FRY-01': 10,
  // Wrasse 10-50g grower S
  'BIO-WR-GRW-S': 50,
  'MOW-WR-GRW-15': 50,
  // Wrasse 50-150g grower L
  'SKR-WR-GRW-30': 150,
  'ALL-WR-ROBUST': 150,
  // Wrasse 150-350g finisher
  'SKR-WR-FIN-XL': 350,
  'BIO-WR-TRAN-45': 350,
  // Lumpfish 0-2g starter
  'SKR-LF-MICRO-01': 2,
  // Lumpfish 2-10g fry
  'BIO-LF-FRY-01': 10,
  // Lumpfish 10-30g grower
  'EWO-LF-GRW-15': 30,
  // Lumpfish 30-50g transfer
  'SKR-LF-TRAN-30': 50,
  // Halibut 0-0.5g larval
  'SKR-HB-GEMMA-01': 0.5,
  // Halibut 0.5-2g starter
  'BIO-HB-INICIO-01': 2,
  // Halibut 2-5g fry
  'SKR-HB-NUTRA-01': 5,
  // Halibut 5-10g grower
  'EWO-HB-GRW-J': 10,
};

async function main() {
  console.log('=== Update Feeds with maxFishWeightG ===\n');
  await login();

  // Get all feeds
  const data = await gqlRequest(`
    query { feeds(pagination: { page: 1 }) { items { id code name minFishWeightG maxFishWeightG } total } }
  `);

  const feeds = data.feeds.items;
  console.log(`Found ${feeds.length} feeds\n`);

  let updated = 0;
  for (const feed of feeds) {
    const maxWeight = MAX_WEIGHT_MAP[feed.code];
    if (maxWeight == null) {
      console.log(`SKIP: ${feed.code} - no mapping`);
      continue;
    }
    if (feed.maxFishWeightG != null) {
      console.log(`SKIP: ${feed.code} - already has maxFishWeightG=${feed.maxFishWeightG}`);
      continue;
    }

    try {
      await gqlRequest(`
        mutation UpdateFeed($input: UpdateFeedInput!) {
          updateFeed(input: $input) { id code maxFishWeightG }
        }
      `, { input: { id: feed.id, maxFishWeightG: maxWeight } });
      console.log(`OK: ${feed.code} (${feed.name}) -> maxFishWeightG=${maxWeight}g`);
      updated++;
    } catch (e) {
      console.error(`FAIL: ${feed.code} - ${e.message}`);
    }
  }

  console.log(`\nDone! Updated ${updated} feeds.`);
}

main().catch(console.error);
