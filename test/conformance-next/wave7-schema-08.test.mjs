import test from 'node:test';
import {checkInt64AndParameterSerialization} from './wave7-schema-cases.mjs';
test("NEG-SCHEMA-08 int64 decimal and parameter style/ explode precise",checkInt64AndParameterSerialization);
