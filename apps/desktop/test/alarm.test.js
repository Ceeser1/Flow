'use strict';

// The phone's Alarm Clock (5.0): when an alarm rings next. The phone counts
// the same way (FlowAlarm.nextAt in the Android app).

const test = require('node:test');
const assert = require('node:assert/strict');
const Alarm = require('../renderer/app/alarm');

// Local times; 2026-11-13 is a Friday.
const at = (day, hour, minute = 0, second = 0) => new Date(2026, 10, day, hour, minute, second).getTime();
const MON = 1;
const WED = 4;
const FRI = 16;
const SAT = 32;
const SUN = 64;

test('no day picked: it rings once, today if the time is still to come, else tomorrow', () => {
  assert.equal(Alarm.nextAt(7, 0, 0, at(13, 6, 30)), at(13, 7));
  assert.equal(Alarm.nextAt(7, 0, 0, at(13, 7, 0, 1)), at(14, 7));
  // The very minute counts as passed: it rings a day later, not at once.
  assert.equal(Alarm.nextAt(7, 0, 0, at(13, 7)), at(14, 7));
  assert.equal(Alarm.nextAt(23, 59, 0, at(13, 23, 58, 59)), at(13, 23, 59));
  assert.equal(Alarm.nextAt(0, 0, 0, at(13, 23, 59)), at(14, 0));
});

test('days picked: the next of them at that time', () => {
  // Friday morning, an alarm for Fridays: today, or after its time next Friday.
  assert.equal(Alarm.nextAt(7, 0, FRI, at(13, 6)), at(13, 7));
  assert.equal(Alarm.nextAt(7, 0, FRI, at(13, 8)), at(20, 7));
  // Saturday and Sunday from a Friday evening; Monday and Wednesday over the weekend.
  assert.equal(Alarm.nextAt(9, 30, SAT | SUN, at(13, 20)), at(14, 9, 30));
  assert.equal(Alarm.nextAt(9, 30, SUN, at(13, 20)), at(15, 9, 30));
  assert.equal(Alarm.nextAt(6, 15, MON | WED, at(13, 20)), at(16, 6, 15));
  assert.equal(Alarm.nextAt(6, 15, MON | WED, at(16, 7)), at(18, 6, 15));
  // Every day is the same as none, but for ringing again.
  assert.equal(Alarm.nextAt(7, 0, 127, at(13, 8)), at(14, 7));
});

test('the days are Monday first', () => {
  assert.deepEqual(Alarm.DAYS, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
});
