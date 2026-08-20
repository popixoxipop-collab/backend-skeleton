package com.example.app.domain.organization.application;

import java.util.UUID;
import com.example.app.domain.organization.domain.Organization;

// P3 (D-fixture-corpus): findOrganization(UUID) -- exactly one argument, matching the fixed
// arity ResourceResolverStub.java.tmpl always generates for fetch(). Resolver generation for
// Organization must succeed against this fixture.
public interface OrganizationService {
	Organization findOrganization(UUID organizationId);
}
