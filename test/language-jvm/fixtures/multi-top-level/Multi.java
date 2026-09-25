package com.example.multi;

// Braces in comments and literals must not change top-level depth: { }
class First {
    char opening = '{';
    String brace = "}";
}

record Second(String value) {}

@interface Marker {}
