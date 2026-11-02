import test from 'node:test';
import { checkUnrealBlueprintRemainsUnexported } from './wave6-case-functions.mjs';
test("NEG-GAME-06 Blueprint-only Unreal declaration cannot pretend a source export contains runtime body", checkUnrealBlueprintRemainsUnexported);
