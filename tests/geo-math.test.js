import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  angleDiff, bearing, cardinal, distance, headingFromOrientation, normalizeDeg, offset, smoothAngle,
} from '../js/geo-math.js';

const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected} ± ${tolerance}, got ${actual}`);

test('distance: 0.001° of latitude is about 111 m', () => {
  near(distance({ lat: 0, lng: 0 }, { lat: 0.001, lng: 0 }), 111.19, 0.05);
});

test('distance: zero for the same point, symmetric, and right at city scale', () => {
  const london = { lat: 51.5074, lng: -0.1278 };
  const paris = { lat: 48.8566, lng: 2.3522 };
  assert.equal(distance(london, london), 0);
  near(distance(london, paris), distance(paris, london), 1e-6);
  near(distance(london, paris), 343_560, 1000);
});

test('bearing: the four main directions', () => {
  const o = { lat: 10, lng: 20 };
  near(bearing(o, { lat: 11, lng: 20 }), 0, 1e-9);
  near(bearing(o, { lat: 10, lng: 21 }), 90, 0.2);
  near(bearing(o, { lat: 9, lng: 20 }), 180, 1e-9);
  near(bearing(o, { lat: 10, lng: 19 }), 270, 0.2);
});

test('offset: round-trips through distance and bearing', () => {
  const o = { lat: 48.8584, lng: 2.2945 };
  for (const deg of [0, 45, 135, 225, 315]) {
    const p = offset(o, 100, deg);
    near(distance(o, p), 100, 0.01);
    near(angleDiff(deg, bearing(o, p)), 0, 0.01);
  }
});

test('normalizeDeg wraps into [0, 360)', () => {
  assert.equal(normalizeDeg(-90), 270);
  assert.equal(normalizeDeg(720), 0);
  assert.equal(normalizeDeg(-0), 0);
  assert.equal(normalizeDeg(359.5), 359.5);
});

test('angleDiff takes the short way round', () => {
  assert.equal(angleDiff(359, 1), 2);
  assert.equal(angleDiff(1, 359), -2);
  assert.equal(angleDiff(0, 180), 180);
  assert.equal(angleDiff(90, 90), 0);
});

test('smoothAngle crosses north without spinning the long way', () => {
  near(smoothAngle(359, 1, 0.5), 0, 1e-9);
  near(smoothAngle(350, 10, 0.5), 0, 1e-9);
  assert.equal(smoothAngle(null, 42), 42);
});

test('headingFromOrientation: phone held flat follows its top edge', () => {
  assert.equal(headingFromOrientation(0, 0, 0), 0);
  assert.equal(headingFromOrientation(90, 0, 0), 270);
  assert.equal(headingFromOrientation(270, 10, -5), 90);
});

test('headingFromOrientation: phone held upright follows its back', () => {
  near(headingFromOrientation(0, 90, 0), 0, 1e-9);
  near(headingFromOrientation(90, 90, 0), 270, 1e-9);
  near(headingFromOrientation(30, 80, 0), 330, 1e-9);
});

test('headingFromOrientation: no reading gives null', () => {
  assert.equal(headingFromOrientation(null, 0, 0), null);
});

test('cardinal labels', () => {
  assert.equal(cardinal(0), 'N');
  assert.equal(cardinal(22), 'N');
  assert.equal(cardinal(23), 'NE');
  assert.equal(cardinal(180), 'S');
  assert.equal(cardinal(350), 'N');
  assert.equal(cardinal(-45), 'NW');
});
