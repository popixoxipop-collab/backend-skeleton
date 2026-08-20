package com.example.app.domain.security.application;

import java.util.UUID;
import com.example.app.domain.security.domain.Beta;

public interface BetaService {
	Beta findBeta(UUID betaId);
}
