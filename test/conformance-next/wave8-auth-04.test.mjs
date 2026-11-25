import test from 'node:test';
import {checkPerOperationPublicAndProtectedOverrides} from './wave8-auth-cases.mjs';
test('NEG-AUTH-04 public and protected overrides are not overwritten',checkPerOperationPublicAndProtectedOverrides);
