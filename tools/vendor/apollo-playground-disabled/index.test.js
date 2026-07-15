'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ApolloServerPluginLandingPageGraphQLPlayground } = require('./index');

test('deprecated Playground activation fails closed', () => {
  assert.throws(
    () => ApolloServerPluginLandingPageGraphQLPlayground(),
    /Deprecated Apollo Playground is disabled/,
  );
});
