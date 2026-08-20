package com.example.app.domain.codeanalysis.domain;

import java.util.UUID;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

// P3 (D-fixture-corpus): an entity with zero controllers in its module -- the exact shape that
// motivated A5 (CONTRACT_EMPTY without CONTRACT_NO_MODULE, since a real module WAS matched, it
// just has no HTTP surface at all).
@Entity
@Table(name = "code_analyses")
public class CodeAnalysis {

	@Id
	private UUID id;

	private String summary;
}
