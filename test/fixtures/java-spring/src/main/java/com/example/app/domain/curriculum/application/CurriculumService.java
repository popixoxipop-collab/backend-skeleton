package com.example.app.domain.curriculum.application;

import java.util.UUID;
import com.example.app.domain.curriculum.domain.Curriculum;

// P3 (D-fixture-corpus) / D-security-8: findCurriculum(UUID, UUID) -- TWO arguments (scoped by
// an owning organization), not the single resource UUID ResourceResolverStub.java.tmpl always
// passes. A resolver must NOT be generated for Curriculum against this fixture -- generating one
// anyway would either fail to compile or silently call the wrong overload and drop the scoping
// argument (an IDOR-shaped bug, the exact defect D-security-8 closed).
public interface CurriculumService {
	Curriculum findCurriculum(UUID organizationId, UUID curriculumId);
}
