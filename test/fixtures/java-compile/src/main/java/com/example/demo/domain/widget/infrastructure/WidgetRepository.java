package com.example.demo.domain.widget.infrastructure;

import com.example.demo.domain.widget.domain.Widget;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

// O4 (D-handle-lifecycle): backs WidgetServiceImpl -- this fixture's first real (non-stub)
// persistence path, needed so the handle-lifecycle @SpringBootTest exercises a genuinely running
// app against a real database, not just a compile check.
public interface WidgetRepository extends JpaRepository<Widget, UUID> {
}
