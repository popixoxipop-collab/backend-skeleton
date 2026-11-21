import test from 'node:test';
import {checkMultipartTransportDistinct} from './wave7-schema-cases.mjs';
test("NEG-SCHEMA-07 multipart binary remains media-specific",checkMultipartTransportDistinct);
