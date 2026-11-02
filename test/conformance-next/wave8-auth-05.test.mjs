import test from 'node:test';
import {checkAndVsOrAlternatives} from './wave8-auth-cases.mjs';
test('NEG-AUTH-05 AND and OR requirements retain distinct structures',checkAndVsOrAlternatives);
