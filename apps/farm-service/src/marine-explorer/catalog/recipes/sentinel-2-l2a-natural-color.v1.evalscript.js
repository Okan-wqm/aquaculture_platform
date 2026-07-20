//VERSION=3

function setup() {
  return {
    input: [
      {
        bands: ['B02', 'B03', 'B04', 'dataMask'],
        units: 'REFLECTANCE',
      },
    ],
    output: [
      {
        id: 'display',
        bands: 4,
        sampleType: 'AUTO',
      },
    ],
  };
}

function evaluatePixel(sample) {
  return {
    display: [2.5 * sample.B04, 2.5 * sample.B03, 2.5 * sample.B02, sample.dataMask],
  };
}
