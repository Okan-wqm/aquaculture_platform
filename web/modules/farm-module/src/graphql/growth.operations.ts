/**
 * Growth GraphQL Operations
 *
 * Buyume olcumleri ve analiz icin GraphQL query ve mutation tanimlari.
 * Backend growth.resolver.ts ile uyumlu.
 *
 * @module FarmModule/GraphQL
 */

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Tek bir buyume olcumu getir
 */
export const GROWTH_MEASUREMENT_QUERY = `
  query GrowthMeasurement($id: ID!) {
    growthMeasurement(id: $id) {
      id
      tenantId
      batchId
      tankId
      pondId
      measurementDate
      measurementType
      measurementMethod
      sampleSize
      populationSize
      samplePercent
      individualMeasurements
      statistics
      averageWeight
      averageLength
      weightCV
      conditionFactor
      growthComparison
      performance
      fcrAnalysis
      estimatedBiomass
      previousBiomass
      biomassGain
      suggestedActions
      conditions
      isVerified
      verifiedBy
      verifiedAt
      measuredBy
      notes
      updateBatchWeight
      isProcessed
      createdAt
      updatedAt
      isUniformGrowth
      needsGrading
      isOnTarget
      isFCROnTarget
      minWeight
      maxWeight
      medianWeight
      weightStdDev
      weightRange
      dailyGrowthRate
      specificGrowthRate
      periodFCR
      cumulativeFCR
      fcrTrend
      hasHighPriorityActions
      actionCount
    }
  }
`;

/**
 * Buyume olcumlerini filtreli listele
 */
export const GROWTH_MEASUREMENTS_QUERY = `
  query GrowthMeasurements(
    $filter: GrowthMeasurementFilterInput
    $pagination: GrowthPaginationInput
  ) {
    growthMeasurements(filter: $filter, pagination: $pagination) {
      items {
        id
        tenantId
        batchId
        tankId
        measurementDate
        measurementType
        measurementMethod
        sampleSize
        populationSize
        averageWeight
        averageLength
        weightCV
        conditionFactor
        performance
        estimatedBiomass
        biomassGain
        isVerified
        measuredBy
        notes
        createdAt
        samplePercent
        isUniformGrowth
        needsGrading
        isOnTarget
        isFCROnTarget
        dailyGrowthRate
        specificGrowthRate
        periodFCR
        cumulativeFCR
        fcrTrend
        hasHighPriorityActions
        actionCount
      }
      total
      hasMore
    }
  }
`;

/**
 * Batch icin buyume analizi getir
 */
export const GROWTH_ANALYSIS_QUERY = `
  query GrowthAnalysis($batchId: ID!) {
    growthAnalysis(batchId: $batchId) {
      batchId
      batchCode
      speciesName
      analysisDate
      daysInProduction
      currentMetrics {
        currentAvgWeightG
        theoreticalWeightG
        weightVariancePercent
        currentBiomassKg
        currentQuantity
        survivalRate
        mortalityRate
        currentFCR
        targetFCR
        fcrVariancePercent
        dailyGrowthRateG
        specificGrowthRate
        weightCV
        performanceRating
      }
      trend {
        direction
        avgDailyGrowthLast7Days
        avgDailyGrowthLast30Days
        growthAcceleration
        fcrTrend
        fcrChangeLast7Days
      }
      projection {
        projectedWeightIn30Days
        projectedBiomassIn30Days
        estimatedHarvestDate
        harvestTargetWeightG
        daysToHarvest
        projectedTotalFeedKg
        projectedFinalFCR
      }
      recommendations {
        priority
        type
        description
        reason
        actionRequired
      }
      measurementHistory {
        id
        measurementDate
        averageWeight
        weightCV
        sampleSize
        estimatedBiomass
        dailyGrowthRate
        periodFCR
        performance
      }
    }
  }
`;

/**
 * Batch icin son olcumu getir
 */
export const LATEST_GROWTH_MEASUREMENT_QUERY = `
  query LatestGrowthMeasurement($batchId: ID!) {
    latestGrowthMeasurement(batchId: $batchId) {
      id
      tenantId
      batchId
      tankId
      measurementDate
      measurementType
      sampleSize
      populationSize
      averageWeight
      averageLength
      weightCV
      conditionFactor
      performance
      estimatedBiomass
      biomassGain
      isVerified
      measuredBy
      createdAt
      dailyGrowthRate
      specificGrowthRate
      periodFCR
      isOnTarget
      isFCROnTarget
    }
  }
`;

/**
 * Batch buyume gecmisi
 */
export const BATCH_GROWTH_HISTORY_QUERY = `
  query BatchGrowthHistory($batchId: ID!, $limit: Int) {
    batchGrowthHistory(batchId: $batchId, limit: $limit) {
      id
      tenantId
      batchId
      tankId
      measurementDate
      measurementType
      measurementMethod
      sampleSize
      populationSize
      averageWeight
      averageLength
      weightCV
      conditionFactor
      performance
      estimatedBiomass
      biomassGain
      isVerified
      measuredBy
      notes
      createdAt
      dailyGrowthRate
      specificGrowthRate
      periodFCR
      cumulativeFCR
      isOnTarget
      needsGrading
    }
  }
`;

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Yeni buyume ornekleme kaydi olustur
 */
export const RECORD_GROWTH_SAMPLE_MUTATION = `
  mutation RecordGrowthSample($input: RecordGrowthSampleInput!) {
    recordGrowthSample(input: $input) {
      id
      tenantId
      batchId
      tankId
      measurementDate
      measurementType
      measurementMethod
      sampleSize
      populationSize
      averageWeight
      averageLength
      weightCV
      conditionFactor
      performance
      estimatedBiomass
      biomassGain
      isVerified
      measuredBy
      notes
      createdAt
      dailyGrowthRate
      specificGrowthRate
      periodFCR
      isOnTarget
      needsGrading
      hasHighPriorityActions
      actionCount
    }
  }
`;

/**
 * Batch agirligini olcum sonucuyla guncelle
 */
export const UPDATE_BATCH_WEIGHT_FROM_SAMPLE_MUTATION = `
  mutation UpdateBatchWeightFromSample(
    $batchId: ID!
    $measurementId: ID!
  ) {
    updateBatchWeightFromSample(
      batchId: $batchId
      measurementId: $measurementId
    ) {
      id
      batchId
      averageWeight
      estimatedBiomass
      isProcessed
    }
  }
`;

/**
 * Olcumu dogrula
 */
export const VERIFY_MEASUREMENT_MUTATION = `
  mutation VerifyMeasurement(
    $measurementId: ID!
    $notes: String
  ) {
    verifyMeasurement(
      measurementId: $measurementId
      notes: $notes
    ) {
      id
      isVerified
      verifiedBy
      verifiedAt
    }
  }
`;
