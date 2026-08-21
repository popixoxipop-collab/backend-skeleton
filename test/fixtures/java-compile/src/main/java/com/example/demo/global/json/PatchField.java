package com.example.demo.global.json;

// A3 (D-patch-strategy): a minimal stand-in for the real oracle repo's own PatchField<T> wrapper
// (global/json/PatchField.java) -- same shape (record, of(), null vs PatchField(null) distinction)
// but without the real one's Jackson custom-deserializer wiring, which this fixture doesn't need
// since it's never actually deserialized from JSON here, only constructed by generated code.
public record PatchField<T>(T value) {
	public static <T> PatchField<T> of(T value) {
		return new PatchField<>(value);
	}
}
