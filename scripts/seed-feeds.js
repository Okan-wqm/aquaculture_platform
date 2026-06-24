/**
 * Feed Seeding Script
 * Creates suppliers and feeds with advanced feeding curves for:
 * - Ballan Wrasse (0-350g): 10 feed alternatives
 * - Lumpfish (0-50g): 4 feed alternatives
 * - Halibut (0-10g): 4 feed alternatives
 */
import { createGraphqlRequester } from './lib/graphql-http-client.mjs';

const TENANT_ID = 'ad6ca8fd-cdf7-4e6b-b68e-f17ad6484490';
const SITE_ID = '11111111-1111-4111-8111-111111111111'; // Bodrum RAS
const GRAPHQL_ENDPOINT =
  process.env.FEED_GRAPHQL_URL ?? process.env.GRAPHQL_URL ?? 'http://localhost:3000/graphql';

// Existing supplier IDs
const SKRETTING_ID = 'e1111111-1111-1111-8111-111111111112';
const BIOMAR_ID = 'e1111111-1111-1111-8111-111111111113';

let TOKEN = '';

const gqlRequest = createGraphqlRequester({
  endpoint: GRAPHQL_ENDPOINT,
  tenantId: TENANT_ID,
  getToken: () => TOKEN,
});

async function login() {
  const data = await gqlRequest(`
    mutation { login(input: { email: "okan@suderra.com", password: "12345678" }) { accessToken } }
  `);
  TOKEN = data.login.accessToken;
  console.log('Logged in successfully');
}

// ============================================================================
// SUPPLIERS
// ============================================================================

async function createSuppliers() {
  const newSuppliers = [
    {
      name: 'EWOS (Cargill Aqua)',
      code: 'SUP-FEED-03',
      type: 'FEED',
      contactPerson: 'Erik Hansen',
      email: 'erik.hansen@ewos.com',
      phone: '+47-555-0103',
      address: { city: 'Bergen', country: 'Norway' },
    },
    {
      name: 'Mowi Feed',
      code: 'SUP-FEED-04',
      type: 'FEED',
      contactPerson: 'Lars Olsen',
      email: 'lars.olsen@mowifeed.com',
      phone: '+47-555-0104',
      address: { city: 'Valsneset', country: 'Norway' },
    },
    {
      name: 'Aller Aqua',
      code: 'SUP-FEED-05',
      type: 'FEED',
      contactPerson: 'Hans Andersen',
      email: 'hans@alleraqua.com',
      phone: '+45-555-0105',
      address: { city: 'Christiansfeld', country: 'Denmark' },
    },
  ];

  const supplierIds = {};
  for (const s of newSuppliers) {
    try {
      const data = await gqlRequest(`
        mutation CreateSupplier($input: CreateSupplierInput!) {
          createSupplier(input: $input) { id name code }
        }
      `, { input: s });
      supplierIds[s.code] = data.createSupplier.id;
      console.log(`Created supplier: ${s.name} (${data.createSupplier.id})`);
    } catch (e) {
      console.log(`Supplier ${s.name} may already exist: ${e.message}`);
    }
  }
  return supplierIds;
}

// ============================================================================
// FEEDING MATRIX GENERATORS
// ============================================================================

/**
 * Generate a 2D feeding matrix (temperature x weight)
 * @param {number[]} temps - Temperature axis (°C)
 * @param {number[]} weights - Weight axis (grams)
 * @param {number} baseRate - Base feeding rate at optimal temp/weight
 * @param {number} tempCoeff - Rate increase per °C
 * @param {number} weightDecay - Rate decrease per weight step
 */
function generateMatrix(temps, weights, baseRate, tempCoeff, weightDecay) {
  const rates = [];
  const fcrMatrix = [];
  const optTempIdx = Math.floor(temps.length / 2);

  for (let ti = 0; ti < temps.length; ti++) {
    const row = [];
    const fcrRow = [];
    const tempFactor = 1 + (ti - optTempIdx) * tempCoeff;
    for (let wi = 0; wi < weights.length; wi++) {
      const weightFactor = 1 - wi * weightDecay;
      const rate = Math.max(0.3, +(baseRate * tempFactor * weightFactor).toFixed(2));
      row.push(rate);
      // FCR increases as fish grow (less efficient)
      const fcr = +(0.7 + wi * 0.08 + Math.abs(ti - optTempIdx) * 0.03).toFixed(2);
      fcrRow.push(fcr);
    }
    rates.push(row);
    fcrMatrix.push(fcrRow);
  }
  return { temperatures: temps, weights, rates, fcrMatrix, temperatureUnit: 'celsius', weightUnit: 'gram' };
}

// Ballan Wrasse matrix: 8-18°C, various weight ranges
function wrasseMatrix(minW, maxW) {
  const temps = [8, 10, 12, 14, 16, 18];
  const steps = 6;
  const weights = [];
  const step = (maxW - minW) / (steps - 1);
  for (let i = 0; i < steps; i++) weights.push(+(minW + step * i).toFixed(1));
  return generateMatrix(temps, weights, 3.5, 0.08, 0.12);
}

// Lumpfish matrix: 6-14°C
function lumpfishMatrix(minW, maxW) {
  const temps = [6, 8, 10, 12, 14];
  const steps = 5;
  const weights = [];
  const step = (maxW - minW) / (steps - 1);
  for (let i = 0; i < steps; i++) weights.push(+(minW + step * i).toFixed(1));
  return generateMatrix(temps, weights, 4.0, 0.07, 0.1);
}

// Halibut matrix: 10-18°C
function halibutMatrix(minW, maxW) {
  const temps = [10, 12, 14, 16, 18];
  const steps = 5;
  const weights = [];
  const step = (maxW - minW) / (steps - 1);
  for (let i = 0; i < steps; i++) weights.push(+(minW + step * i).toFixed(1));
  return generateMatrix(temps, weights, 3.8, 0.06, 0.11);
}

// ============================================================================
// FEED DEFINITIONS
// ============================================================================

function buildFeeds() {
  return [
    // ========================================================================
    // BALLAN WRASSE (0-350g) - 10 feeds
    // ========================================================================
    // 0-2g: 2 alternatives (Starter)
    {
      name: 'Skretting Wrasse Micro Starter',
      code: 'SKR-WR-MICRO-01',
      type: 'STARTER',
      targetSpecies: 'Ballan Wrasse',
      brand: 'Skretting',
      manufacturer: 'Skretting',
      supplierId: SKRETTING_ID,
      pelletSize: 0.3,
      pelletSizeLabel: '0.3mm',
      floatingType: 'SLOW_SINKING',
      minFishWeightG: 0,
      maxFishWeightG: 2,
      productStage: 'First Feeding',
      composition: 'Fish meal, krill meal, squid meal, fish oil, wheat gluten, vitamins, minerals, astaxanthin',
      storageRequirements: 'Cool dry place, <15°C, sealed container',
      shelfLifeMonths: 12,
      pricePerKg: 28.5,
      unitSize: '5kg bucket',
      unitPrice: 142.5,
      minStock: 10,
      quantity: 50,
      nutritionalContent: { crudeProtein: 58, crudeFat: 16, crudeFiber: 0.5, crudeAsh: 10, moisture: 6, phosphorus: 1.5, omega3: 3.2, nfe: 9.5 },
      feedingMatrix2D: wrasseMatrix(0, 2),
      environmentalImpact: { co2EqWithLuc: 4.2, co2EqWithoutLuc: 3.1 },
    },
    {
      name: 'BioMar Inicio Wrasse 03',
      code: 'BIO-WR-INICIO-03',
      type: 'STARTER',
      targetSpecies: 'Ballan Wrasse',
      brand: 'BioMar',
      manufacturer: 'BioMar',
      supplierId: BIOMAR_ID,
      pelletSize: 0.3,
      pelletSizeLabel: '0.3mm',
      floatingType: 'SLOW_SINKING',
      minFishWeightG: 0,
      maxFishWeightG: 2,
      productStage: 'First Feeding',
      composition: 'Fish meal, shrimp meal, fish oil, soy protein concentrate, wheat, vitamins, minerals',
      storageRequirements: 'Dry storage, <18°C, avoid direct sunlight',
      shelfLifeMonths: 10,
      pricePerKg: 26.0,
      unitSize: '5kg bucket',
      unitPrice: 130.0,
      minStock: 10,
      quantity: 40,
      nutritionalContent: { crudeProtein: 56, crudeFat: 15, crudeFiber: 0.8, crudeAsh: 11, moisture: 7, phosphorus: 1.4, omega3: 2.8, nfe: 10.2 },
      feedingMatrix2D: wrasseMatrix(0, 2),
      environmentalImpact: { co2EqWithLuc: 3.8, co2EqWithoutLuc: 2.9 },
    },
    // 2-10g: 2 alternatives (Fry)
    {
      name: 'Skretting Wrasse Wean-Ex',
      code: 'SKR-WR-WEAN-01',
      type: 'FRY',
      targetSpecies: 'Ballan Wrasse',
      brand: 'Skretting',
      manufacturer: 'Skretting',
      supplierId: SKRETTING_ID,
      pelletSize: 0.8,
      pelletSizeLabel: '0.5-0.8mm',
      floatingType: 'SLOW_SINKING',
      minFishWeightG: 2,
      maxFishWeightG: 10,
      productStage: 'Weaning',
      composition: 'Fish meal, krill meal, fish oil, wheat gluten, soy lecithin, vitamins, pigments',
      storageRequirements: 'Cool dry place, <15°C',
      shelfLifeMonths: 12,
      pricePerKg: 22.0,
      unitSize: '10kg bag',
      unitPrice: 220.0,
      minStock: 20,
      quantity: 80,
      nutritionalContent: { crudeProtein: 55, crudeFat: 15, crudeFiber: 0.8, crudeAsh: 10.5, moisture: 7, phosphorus: 1.3, omega3: 3.0, nfe: 11.7 },
      feedingMatrix2D: wrasseMatrix(2, 10),
      environmentalImpact: { co2EqWithLuc: 3.5, co2EqWithoutLuc: 2.7 },
    },
    {
      name: 'EWOS Wrasse Fry Plus',
      code: 'EWO-WR-FRY-01',
      type: 'FRY',
      targetSpecies: 'Ballan Wrasse',
      brand: 'EWOS',
      manufacturer: 'EWOS (Cargill)',
      supplierId: null, // will be set after supplier creation
      pelletSize: 0.8,
      pelletSizeLabel: '0.5-0.8mm',
      floatingType: 'SLOW_SINKING',
      minFishWeightG: 2,
      maxFishWeightG: 10,
      productStage: 'Fry',
      composition: 'Fish meal, squid meal, fish oil, wheat, soy protein, vitamins, carotenoids',
      storageRequirements: 'Dry, cool, <18°C',
      shelfLifeMonths: 11,
      pricePerKg: 20.5,
      unitSize: '10kg bag',
      unitPrice: 205.0,
      minStock: 20,
      quantity: 60,
      nutritionalContent: { crudeProtein: 54, crudeFat: 14, crudeFiber: 1.0, crudeAsh: 11, moisture: 7, phosphorus: 1.4, omega3: 2.6, nfe: 12.0 },
      feedingMatrix2D: wrasseMatrix(2, 10),
      environmentalImpact: { co2EqWithLuc: 3.3, co2EqWithoutLuc: 2.5 },
    },
    // 10-50g: 2 alternatives (Grower S)
    {
      name: 'BioMar Wrasse Grower Small',
      code: 'BIO-WR-GRW-S',
      type: 'GROWER',
      targetSpecies: 'Ballan Wrasse',
      brand: 'BioMar',
      manufacturer: 'BioMar',
      supplierId: BIOMAR_ID,
      pelletSize: 1.5,
      pelletSizeLabel: '1.0-1.5mm',
      floatingType: 'SLOW_SINKING',
      minFishWeightG: 10,
      maxFishWeightG: 50,
      productStage: 'Grower S',
      composition: 'Fish meal, fish oil, soy protein, wheat gluten, rapeseed oil, vitamins, minerals, astaxanthin',
      storageRequirements: 'Cool storage, <20°C, dry conditions',
      shelfLifeMonths: 14,
      pricePerKg: 16.0,
      unitSize: '25kg bag',
      unitPrice: 400.0,
      minStock: 50,
      quantity: 200,
      nutritionalContent: { crudeProtein: 52, crudeFat: 16, crudeFiber: 1.2, crudeAsh: 9.5, moisture: 7, phosphorus: 1.2, omega3: 2.8, nfe: 14.3 },
      feedingMatrix2D: wrasseMatrix(10, 50),
      environmentalImpact: { co2EqWithLuc: 2.9, co2EqWithoutLuc: 2.2 },
    },
    {
      name: 'Mowi Wrasse Grow 15',
      code: 'MOW-WR-GRW-15',
      type: 'GROWER',
      targetSpecies: 'Ballan Wrasse',
      brand: 'Mowi Feed',
      manufacturer: 'Mowi Feed',
      supplierId: null,
      pelletSize: 1.5,
      pelletSizeLabel: '1.0-1.5mm',
      floatingType: 'SLOW_SINKING',
      minFishWeightG: 10,
      maxFishWeightG: 50,
      productStage: 'Grower S',
      composition: 'Fish meal, krill oil, rapeseed oil, wheat, soy protein concentrate, vitamins, minerals',
      storageRequirements: 'Dry, <20°C, away from direct sunlight',
      shelfLifeMonths: 12,
      pricePerKg: 15.5,
      unitSize: '25kg bag',
      unitPrice: 387.5,
      minStock: 50,
      quantity: 150,
      nutritionalContent: { crudeProtein: 50, crudeFat: 17, crudeFiber: 1.5, crudeAsh: 9, moisture: 7.5, phosphorus: 1.1, omega3: 3.0, nfe: 15.0 },
      feedingMatrix2D: wrasseMatrix(10, 50),
      environmentalImpact: { co2EqWithLuc: 2.7, co2EqWithoutLuc: 2.0 },
    },
    // 50-150g: 2 alternatives (Grower L)
    {
      name: 'Skretting Wrasse Grower 30',
      code: 'SKR-WR-GRW-30',
      type: 'GROWER',
      targetSpecies: 'Ballan Wrasse',
      brand: 'Skretting',
      manufacturer: 'Skretting',
      supplierId: SKRETTING_ID,
      pelletSize: 3.0,
      pelletSizeLabel: '2-3mm',
      floatingType: 'SLOW_SINKING',
      minFishWeightG: 50,
      maxFishWeightG: 150,
      productStage: 'Grower L',
      composition: 'Fish meal, rapeseed oil, fish oil, soy protein, wheat, vitamins, minerals, natural pigments',
      storageRequirements: 'Cool dry storage, <20°C',
      shelfLifeMonths: 15,
      pricePerKg: 12.0,
      unitSize: '25kg bag',
      unitPrice: 300.0,
      minStock: 100,
      quantity: 500,
      nutritionalContent: { crudeProtein: 48, crudeFat: 18, crudeFiber: 1.8, crudeAsh: 8.5, moisture: 7, phosphorus: 1.0, omega3: 2.5, nfe: 16.7 },
      feedingMatrix2D: wrasseMatrix(50, 150),
      environmentalImpact: { co2EqWithLuc: 2.5, co2EqWithoutLuc: 1.8 },
    },
    {
      name: 'Aller Aqua Wrasse Robust',
      code: 'ALL-WR-ROBUST',
      type: 'GROWER',
      targetSpecies: 'Ballan Wrasse',
      brand: 'Aller Aqua',
      manufacturer: 'Aller Aqua',
      supplierId: null,
      pelletSize: 3.0,
      pelletSizeLabel: '2-3mm',
      floatingType: 'FLOATING',
      minFishWeightG: 50,
      maxFishWeightG: 150,
      productStage: 'Grower L',
      composition: 'Fish meal, insect meal, rapeseed oil, wheat, vitamins, minerals, beta-glucans',
      storageRequirements: 'Dry place, <22°C',
      shelfLifeMonths: 14,
      pricePerKg: 11.5,
      unitSize: '25kg bag',
      unitPrice: 287.5,
      minStock: 100,
      quantity: 400,
      nutritionalContent: { crudeProtein: 47, crudeFat: 17, crudeFiber: 2.0, crudeAsh: 9, moisture: 7, phosphorus: 1.1, omega3: 2.2, nfe: 18.0 },
      feedingMatrix2D: wrasseMatrix(50, 150),
      environmentalImpact: { co2EqWithLuc: 2.1, co2EqWithoutLuc: 1.5 },
    },
    // 150-350g: 2 alternatives (Finisher)
    {
      name: 'Skretting Wrasse Finish XL',
      code: 'SKR-WR-FIN-XL',
      type: 'FINISHER',
      targetSpecies: 'Ballan Wrasse',
      brand: 'Skretting',
      manufacturer: 'Skretting',
      supplierId: SKRETTING_ID,
      pelletSize: 4.5,
      pelletSizeLabel: '4-5mm',
      floatingType: 'FLOATING',
      minFishWeightG: 150,
      maxFishWeightG: 350,
      productStage: 'Finisher',
      composition: 'Fish meal, rapeseed oil, soy protein, wheat, fish oil, vitamins, astaxanthin, minerals',
      storageRequirements: 'Dry, <20°C, use within 3 months of opening',
      shelfLifeMonths: 18,
      pricePerKg: 10.0,
      unitSize: '25kg bag',
      unitPrice: 250.0,
      minStock: 200,
      quantity: 800,
      nutritionalContent: { crudeProtein: 45, crudeFat: 20, crudeFiber: 2.0, crudeAsh: 8, moisture: 7, phosphorus: 0.9, omega3: 2.8, nfe: 18.0 },
      feedingMatrix2D: wrasseMatrix(150, 350),
      environmentalImpact: { co2EqWithLuc: 2.3, co2EqWithoutLuc: 1.6 },
    },
    {
      name: 'BioMar Wrasse Transfer 45',
      code: 'BIO-WR-TRAN-45',
      type: 'FINISHER',
      targetSpecies: 'Ballan Wrasse',
      brand: 'BioMar',
      manufacturer: 'BioMar',
      supplierId: BIOMAR_ID,
      pelletSize: 4.5,
      pelletSizeLabel: '4-5mm',
      floatingType: 'SLOW_SINKING',
      minFishWeightG: 150,
      maxFishWeightG: 350,
      productStage: 'Transfer/Finisher',
      composition: 'Fish meal, fish oil, rapeseed oil, soy protein, wheat gluten, vitamins, minerals, immune stimulants',
      storageRequirements: 'Cool, dry, <18°C',
      shelfLifeMonths: 15,
      pricePerKg: 10.5,
      unitSize: '25kg bag',
      unitPrice: 262.5,
      minStock: 200,
      quantity: 600,
      nutritionalContent: { crudeProtein: 46, crudeFat: 19, crudeFiber: 1.8, crudeAsh: 8.5, moisture: 7, phosphorus: 1.0, omega3: 3.0, nfe: 17.7 },
      feedingMatrix2D: wrasseMatrix(150, 350),
      environmentalImpact: { co2EqWithLuc: 2.4, co2EqWithoutLuc: 1.7 },
    },

    // ========================================================================
    // LUMPFISH (0-50g) - 4 feeds
    // ========================================================================
    // 0-2g (Starter)
    {
      name: 'Skretting Lumpfish Micro Start',
      code: 'SKR-LF-MICRO-01',
      type: 'STARTER',
      targetSpecies: 'Lumpfish',
      brand: 'Skretting',
      manufacturer: 'Skretting',
      supplierId: SKRETTING_ID,
      pelletSize: 0.3,
      pelletSizeLabel: '0.2-0.4mm',
      floatingType: 'SLOW_SINKING',
      minFishWeightG: 0,
      maxFishWeightG: 2,
      productStage: 'First Feeding',
      composition: 'Fish meal, krill meal, squid meal, fish oil, wheat, vitamins, minerals, taurine',
      storageRequirements: 'Refrigerated, <10°C, sealed',
      shelfLifeMonths: 9,
      pricePerKg: 32.0,
      unitSize: '2kg bucket',
      unitPrice: 64.0,
      minStock: 5,
      quantity: 20,
      nutritionalContent: { crudeProtein: 60, crudeFat: 14, crudeFiber: 0.4, crudeAsh: 12, moisture: 6, phosphorus: 1.6, omega3: 3.5, nfe: 7.6 },
      feedingMatrix2D: lumpfishMatrix(0, 2),
      environmentalImpact: { co2EqWithLuc: 4.5, co2EqWithoutLuc: 3.4 },
    },
    // 2-10g (Fry)
    {
      name: 'BioMar Lumpfish Fry Supreme',
      code: 'BIO-LF-FRY-01',
      type: 'FRY',
      targetSpecies: 'Lumpfish',
      brand: 'BioMar',
      manufacturer: 'BioMar',
      supplierId: BIOMAR_ID,
      pelletSize: 0.8,
      pelletSizeLabel: '0.5-0.8mm',
      floatingType: 'SLOW_SINKING',
      minFishWeightG: 2,
      maxFishWeightG: 10,
      productStage: 'Fry',
      composition: 'Fish meal, shrimp meal, fish oil, wheat gluten, soy lecithin, vitamins, beta-glucans',
      storageRequirements: 'Cool, <15°C, dry',
      shelfLifeMonths: 11,
      pricePerKg: 24.0,
      unitSize: '5kg bag',
      unitPrice: 120.0,
      minStock: 10,
      quantity: 40,
      nutritionalContent: { crudeProtein: 56, crudeFat: 15, crudeFiber: 0.8, crudeAsh: 10, moisture: 7, phosphorus: 1.3, omega3: 3.0, nfe: 11.2 },
      feedingMatrix2D: lumpfishMatrix(2, 10),
      environmentalImpact: { co2EqWithLuc: 3.6, co2EqWithoutLuc: 2.7 },
    },
    // 10-30g (Grower)
    {
      name: 'EWOS Lumpfish Grower 15',
      code: 'EWO-LF-GRW-15',
      type: 'GROWER',
      targetSpecies: 'Lumpfish',
      brand: 'EWOS',
      manufacturer: 'EWOS (Cargill)',
      supplierId: null,
      pelletSize: 1.5,
      pelletSizeLabel: '1.0-1.5mm',
      floatingType: 'SLOW_SINKING',
      minFishWeightG: 10,
      maxFishWeightG: 30,
      productStage: 'Grower',
      composition: 'Fish meal, fish oil, rapeseed oil, wheat, soy protein, vitamins, minerals, carotenoids',
      storageRequirements: 'Dry, <20°C',
      shelfLifeMonths: 14,
      pricePerKg: 14.5,
      unitSize: '25kg bag',
      unitPrice: 362.5,
      minStock: 30,
      quantity: 120,
      nutritionalContent: { crudeProtein: 50, crudeFat: 16, crudeFiber: 1.5, crudeAsh: 9, moisture: 7, phosphorus: 1.1, omega3: 2.5, nfe: 16.5 },
      feedingMatrix2D: lumpfishMatrix(10, 30),
      environmentalImpact: { co2EqWithLuc: 2.8, co2EqWithoutLuc: 2.1 },
    },
    // 30-50g (Transfer)
    {
      name: 'Skretting Lumpfish Transfer 30',
      code: 'SKR-LF-TRAN-30',
      type: 'GROWER',
      targetSpecies: 'Lumpfish',
      brand: 'Skretting',
      manufacturer: 'Skretting',
      supplierId: SKRETTING_ID,
      pelletSize: 3.0,
      pelletSizeLabel: '2-3mm',
      floatingType: 'FLOATING',
      minFishWeightG: 30,
      maxFishWeightG: 50,
      productStage: 'Transfer',
      composition: 'Fish meal, rapeseed oil, fish oil, soy protein, wheat, immune boosters, vitamins',
      storageRequirements: 'Dry, cool, <20°C',
      shelfLifeMonths: 15,
      pricePerKg: 12.5,
      unitSize: '25kg bag',
      unitPrice: 312.5,
      minStock: 50,
      quantity: 200,
      nutritionalContent: { crudeProtein: 48, crudeFat: 18, crudeFiber: 1.8, crudeAsh: 8.5, moisture: 7, phosphorus: 1.0, omega3: 2.8, nfe: 16.7 },
      feedingMatrix2D: lumpfishMatrix(30, 50),
      environmentalImpact: { co2EqWithLuc: 2.5, co2EqWithoutLuc: 1.8 },
    },

    // ========================================================================
    // HALIBUT (0-10g) - 4 feeds
    // ========================================================================
    // 0-0.5g (Larval)
    {
      name: 'Skretting Halibut Gemma Micro',
      code: 'SKR-HB-GEMMA-01',
      type: 'LARVAL',
      targetSpecies: 'Halibut',
      brand: 'Skretting',
      manufacturer: 'Skretting',
      supplierId: SKRETTING_ID,
      pelletSize: 0.15,
      pelletSizeLabel: '0.1-0.2mm',
      floatingType: 'SLOW_SINKING',
      minFishWeightG: 0,
      maxFishWeightG: 0.5,
      productStage: 'Larval',
      composition: 'Marine protein hydrolysate, krill meal, phospholipids, fish oil, vitamins, taurine, DHA',
      storageRequirements: 'Refrigerated, 2-8°C, nitrogen-sealed',
      shelfLifeMonths: 6,
      pricePerKg: 85.0,
      unitSize: '1kg container',
      unitPrice: 85.0,
      minStock: 3,
      quantity: 10,
      nutritionalContent: { crudeProtein: 62, crudeFat: 14, crudeFiber: 0.2, crudeAsh: 12, moisture: 5, phosphorus: 1.8, omega3: 4.5, nfe: 6.8 },
      feedingMatrix2D: halibutMatrix(0, 0.5),
      environmentalImpact: { co2EqWithLuc: 6.2, co2EqWithoutLuc: 4.8 },
    },
    // 0.5-2g (Starter)
    {
      name: 'BioMar Halibut Inicio Plus',
      code: 'BIO-HB-INICIO-01',
      type: 'STARTER',
      targetSpecies: 'Halibut',
      brand: 'BioMar',
      manufacturer: 'BioMar',
      supplierId: BIOMAR_ID,
      pelletSize: 0.4,
      pelletSizeLabel: '0.3-0.5mm',
      floatingType: 'SLOW_SINKING',
      minFishWeightG: 0.5,
      maxFishWeightG: 2,
      productStage: 'First Feeding',
      composition: 'Fish meal, krill meal, fish oil, squid meal, wheat gluten, vitamins, minerals, phospholipids',
      storageRequirements: 'Refrigerated, <10°C, sealed container',
      shelfLifeMonths: 8,
      pricePerKg: 55.0,
      unitSize: '2kg bucket',
      unitPrice: 110.0,
      minStock: 5,
      quantity: 15,
      nutritionalContent: { crudeProtein: 58, crudeFat: 16, crudeFiber: 0.5, crudeAsh: 11, moisture: 6, phosphorus: 1.6, omega3: 4.0, nfe: 8.5 },
      feedingMatrix2D: halibutMatrix(0.5, 2),
      environmentalImpact: { co2EqWithLuc: 5.0, co2EqWithoutLuc: 3.8 },
    },
    // 2-5g (Fry)
    {
      name: 'Skretting Halibut Nutra HP',
      code: 'SKR-HB-NUTRA-01',
      type: 'FRY',
      targetSpecies: 'Halibut',
      brand: 'Skretting',
      manufacturer: 'Skretting',
      supplierId: SKRETTING_ID,
      pelletSize: 0.8,
      pelletSizeLabel: '0.5-0.8mm',
      floatingType: 'SINKING',
      minFishWeightG: 2,
      maxFishWeightG: 5,
      productStage: 'Fry',
      composition: 'Fish meal, fish oil, krill meal, wheat, soy protein, vitamins, minerals, carotenoids',
      storageRequirements: 'Cool, <15°C, dry conditions',
      shelfLifeMonths: 10,
      pricePerKg: 35.0,
      unitSize: '5kg bag',
      unitPrice: 175.0,
      minStock: 8,
      quantity: 30,
      nutritionalContent: { crudeProtein: 55, crudeFat: 17, crudeFiber: 0.8, crudeAsh: 10, moisture: 7, phosphorus: 1.4, omega3: 3.5, nfe: 10.2 },
      feedingMatrix2D: halibutMatrix(2, 5),
      environmentalImpact: { co2EqWithLuc: 4.0, co2EqWithoutLuc: 3.0 },
    },
    // 5-10g (Grower Small)
    {
      name: 'EWOS Halibut Grower Juvenile',
      code: 'EWO-HB-GRW-J',
      type: 'GROWER',
      targetSpecies: 'Halibut',
      brand: 'EWOS',
      manufacturer: 'EWOS (Cargill)',
      supplierId: null,
      pelletSize: 1.5,
      pelletSizeLabel: '1.0-1.5mm',
      floatingType: 'SINKING',
      minFishWeightG: 5,
      maxFishWeightG: 10,
      productStage: 'Juvenile Grower',
      composition: 'Fish meal, fish oil, rapeseed oil, soy protein, wheat gluten, vitamins, minerals, nucleotides',
      storageRequirements: 'Dry, cool, <18°C',
      shelfLifeMonths: 12,
      pricePerKg: 22.0,
      unitSize: '10kg bag',
      unitPrice: 220.0,
      minStock: 15,
      quantity: 60,
      nutritionalContent: { crudeProtein: 52, crudeFat: 18, crudeFiber: 1.2, crudeAsh: 9, moisture: 7, phosphorus: 1.2, omega3: 3.0, nfe: 12.8 },
      feedingMatrix2D: halibutMatrix(5, 10),
      environmentalImpact: { co2EqWithLuc: 3.2, co2EqWithoutLuc: 2.4 },
    },
  ];
}

// ============================================================================
// CREATE FEEDS
// ============================================================================

const CREATE_FEED_MUTATION = `
  mutation CreateFeed($input: CreateFeedInput!) {
    createFeed(input: $input) {
      id
      name
      code
      targetSpecies
      minFishWeightG
    }
  }
`;

async function createFeeds(supplierIds) {
  const feeds = buildFeeds();
  let created = 0;

  for (const feed of feeds) {
    // Resolve supplier IDs for new suppliers
    if (feed.supplierId === null) {
      if (feed.brand === 'EWOS') feed.supplierId = supplierIds['SUP-FEED-03'] || undefined;
      else if (feed.brand === 'Mowi Feed') feed.supplierId = supplierIds['SUP-FEED-04'] || undefined;
      else if (feed.brand === 'Aller Aqua') feed.supplierId = supplierIds['SUP-FEED-05'] || undefined;
    }

    // Remove supplierId if undefined (not null)
    if (!feed.supplierId) delete feed.supplierId;

    const input = {
      name: feed.name,
      code: feed.code,
      type: feed.type,
      targetSpecies: feed.targetSpecies,
      siteId: SITE_ID,
      brand: feed.brand,
      manufacturer: feed.manufacturer,
      supplierId: feed.supplierId,
      pelletSize: feed.pelletSize,
      pelletSizeLabel: feed.pelletSizeLabel,
      floatingType: feed.floatingType,
      minFishWeightG: feed.minFishWeightG,
      maxFishWeightG: feed.maxFishWeightG,
      productStage: feed.productStage,
      composition: feed.composition,
      storageRequirements: feed.storageRequirements,
      shelfLifeMonths: feed.shelfLifeMonths,
      pricePerKg: feed.pricePerKg,
      unitSize: feed.unitSize,
      unitPrice: feed.unitPrice,
      minStock: feed.minStock,
      quantity: feed.quantity,
      nutritionalContent: feed.nutritionalContent,
      feedingMatrix2D: feed.feedingMatrix2D,
      environmentalImpact: feed.environmentalImpact,
    };

    try {
      const data = await gqlRequest(CREATE_FEED_MUTATION, { input });
      console.log(`[${++created}/${feeds.length}] Created: ${data.createFeed.name} (${data.createFeed.code}) - ${data.createFeed.targetSpecies} minW=${data.createFeed.minFishWeightG}g`);
    } catch (e) {
      console.error(`FAILED: ${feed.name} - ${e.message}`);
    }
  }

  console.log(`\nDone! Created ${created}/${feeds.length} feeds.`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('=== Feed Seeding Script ===\n');

  // Login
  await login();

  // Create suppliers
  console.log('\n--- Creating Suppliers ---');
  const supplierIds = await createSuppliers();

  // Create feeds
  console.log('\n--- Creating Feeds ---');
  await createFeeds(supplierIds);

  console.log('\n=== Complete! ===');
  console.log('Species summary:');
  console.log('  Ballan Wrasse (0-350g): 10 feeds');
  console.log('  Lumpfish (0-50g): 4 feeds');
  console.log('  Halibut (0-10g): 4 feeds');
}

main().catch((e) => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
