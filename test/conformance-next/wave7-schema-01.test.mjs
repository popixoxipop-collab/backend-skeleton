import test from 'node:test';
import {checkLossyKeywordFailsClosed} from './wave7-schema-cases.mjs';
test("NEG-SCHEMA-01 lossy patternProperties must fail closed",checkLossyKeywordFailsClosed);
