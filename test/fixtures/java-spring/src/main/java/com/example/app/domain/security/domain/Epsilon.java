package com.example.app.domain.security.domain;

import java.util.UUID;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "epsilons")
public class Epsilon {
	@Id
	private UUID id;
}
