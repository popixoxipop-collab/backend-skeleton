package com.example.demo.domain.widget.domain;

import java.util.UUID;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "widgets")
public class Widget {

	@Id
	private UUID id;

	private String name;
}
