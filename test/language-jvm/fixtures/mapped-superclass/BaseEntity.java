package com.example.domain;

import jakarta.persistence.Id;
import jakarta.persistence.MappedSuperclass;

@MappedSuperclass
public abstract class BaseEntity<ID> {
    @Id
    protected ID id;
}
