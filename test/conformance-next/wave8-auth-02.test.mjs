import test from 'node:test';
import {checkDeclaredSecurityNotRuntimeProof} from './wave8-auth-cases.mjs';
test('NEG-AUTH-02 declaration does not prove enforcement',checkDeclaredSecurityNotRuntimeProof);
