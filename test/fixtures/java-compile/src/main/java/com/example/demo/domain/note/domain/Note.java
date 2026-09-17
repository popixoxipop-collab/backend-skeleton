package com.example.demo.domain.note.domain;

import java.util.UUID;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;

// D-spring-data-rest-adapter: isolated on purpose -- no hand-written controller anywhere in this
// module, unlike Widget (whose own WidgetController already owns GET/PATCH /widgets/{widgetId});
// adding @RepositoryRestResource(path = "widgets") to WidgetRepository would create a real,
// ambiguous-mapping route conflict against that controller in the actual app, not a hypothetical
// one. Note exists solely to prove the real spring-boot-starter-data-rest dependency + a
// @RepositoryRestResource interface actually compile, and that `handles emit` for every other
// resource stays uncorrupted now that this one legitimately gets willGenerateResolver: false.
@Getter
@Setter
@Entity
@Table(name = "notes")
public class Note {

	@Id
	private UUID id;

	private String body;
}
