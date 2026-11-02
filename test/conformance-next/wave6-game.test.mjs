import test from 'node:test';
import { checkWebgameInputCausalityUnknown, checkNativeSourceNotSelfCertified, checkGodotSceneScopedIdentity, checkUnrealBlueprintRemainsUnexported, checkUnityExactGuidSourceBinding } from './wave6-case-functions.mjs';
test("NEG-GAME-01 adjacent input and motion declarations retain unresolved causal effect", checkWebgameInputCausalityUnknown);
test("NEG-GAME-02 source-only native export cannot self-certify causality or runtime behavior", checkNativeSourceNotSelfCertified);
test("NEG-GAME-03 equal local names in two scenes preserve distinct source-scoped identities", checkGodotSceneScopedIdentity);
test("NEG-GAME-06 Blueprint-only Unreal declaration cannot pretend a source export contains runtime body", checkUnrealBlueprintRemainsUnexported);
test("NEG-GAME-07 Unity GUID edits invalidate exact artifact binding, never silently reuse old asset identity", checkUnityExactGuidSourceBinding);
