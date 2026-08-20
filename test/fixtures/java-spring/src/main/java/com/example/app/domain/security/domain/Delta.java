package com.example.app.domain.security.domain;

import java.util.UUID;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

// P3 (D-fixture-corpus): deliberately has NO matching DeltaService.java under
// domain/security/application/ -- the third arity case (missing service file entirely, not a
// 1-arg or 2-arg mismatch) findServiceFile()/planHandles() must handle by not generating a
// resolver at all, with an explicit note.
@Entity
@Table(name = "deltas")
public class Delta {
	@Id
	private UUID id;
}
