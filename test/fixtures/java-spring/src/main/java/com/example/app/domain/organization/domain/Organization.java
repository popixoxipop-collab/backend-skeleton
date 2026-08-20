package com.example.app.domain.organization.domain;

import java.time.Instant;
import java.util.UUID;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "organizations")
public class Organization {

	@Id
	private UUID id;

	private String name;

	@Enumerated(EnumType.STRING)
	private OrganizationStatus status;

	private Instant createdAt;
}
