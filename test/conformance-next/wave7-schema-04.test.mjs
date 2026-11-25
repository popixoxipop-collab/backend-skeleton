import test from 'node:test';
import {checkUnionsAndDiscriminatorPreserved} from './wave7-schema-cases.mjs';
test("NEG-SCHEMA-04 oneOf anyOf and discriminator retained",checkUnionsAndDiscriminatorPreserved);
