import assert from 'node:assert/strict';
import test from 'node:test';

import {assertPublishedRecordingVerified} from './garnet-dependabot-publish.mjs';

test('published verified recording keeps comparison HOLD successful', () => {
  assert.doesNotThrow(() => assertPublishedRecordingVerified({
    recording_verified: true,
    comparison_matched: false,
  }));
});

test('published incomplete recording fails after publication', () => {
  for (const recording_verified of [false, undefined]) {
    assert.throws(
      () => assertPublishedRecordingVerified({recording_verified}),
      {message: 'published_recording_not_verified'},
    );
  }
});
