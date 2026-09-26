package com.example.domain;

import jakarta.persistence.Entity;

@Entity
public final class Widget extends BaseEntity<java.util.UUID> implements NamedEntity {
    private String name;
}

interface NamedEntity {}
