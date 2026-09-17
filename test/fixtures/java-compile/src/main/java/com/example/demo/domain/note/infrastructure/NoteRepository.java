package com.example.demo.domain.note.infrastructure;

import com.example.demo.domain.note.domain.Note;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.rest.core.annotation.RepositoryRestResource;

import java.util.UUID;

// D-spring-data-rest-adapter: the real-compile proof for scanners/adapters/java-spring.mjs's
// extractRepositoryResource() -- proves spring-boot-starter-data-rest + this shape actually
// compile against a real Spring Boot app, not just a hand-built scan-report fixture.
@RepositoryRestResource(path = "notes")
public interface NoteRepository extends JpaRepository<Note, UUID> {
}
