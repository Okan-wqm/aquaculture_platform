//VERSION=3

const NDWI_NODATA = -9999;

function setup() {
  return {
    input: [
      {
        bands: ['B03', 'B08', 'dataMask'],
        units: 'REFLECTANCE',
      },
    ],
    output: [
      {
        id: 'analytic',
        bands: 1,
        sampleType: 'FLOAT32',
        nodataValue: NDWI_NODATA,
      },
      {
        id: 'dataMask',
        bands: 1,
        sampleType: 'UINT8',
        nodataValue: 0,
      },
      {
        id: 'display',
        bands: 4,
        sampleType: 'AUTO',
      },
    ],
  };
}

function evaluatePixel(sample) {
  const denominator = sample.B03 + sample.B08;
  const valid = sample.dataMask === 1 && denominator !== 0;

  if (!valid) {
    return {
      analytic: [NDWI_NODATA],
      dataMask: [0],
      display: [0, 0, 0, 0],
    };
  }

  const ndwi = (sample.B03 - sample.B08) / denominator;
  let qualitativeColor;

  if (ndwi < 0) {
    qualitativeColor = [0.45, 0.3, 0.15];
  } else if (ndwi < 0.2) {
    qualitativeColor = [0.85, 0.85, 0.65];
  } else {
    qualitativeColor = [0.05, 0.35, 0.85];
  }

  return {
    analytic: [ndwi],
    dataMask: [1],
    display: [...qualitativeColor, 1],
  };
}
