package com.example.dto;

import java.util.List;
import java.util.Map;

public record PageEnvelope<T extends Comparable<T>>(
        List<T> items,
        Map<String, List<T>> grouped
) implements java.io.Serializable {}
