package com.example.app.domain.curriculum.domain;

import java.util.UUID;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "curricula")
public class Curriculum {

	@Id
	private UUID id;

	private String title;
}
