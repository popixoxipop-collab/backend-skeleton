package com.example.app.domain.security.application;

import java.util.UUID;
import com.example.app.domain.security.domain.Gamma;

public interface GammaService {
	Gamma findGamma(UUID gammaId);
}
