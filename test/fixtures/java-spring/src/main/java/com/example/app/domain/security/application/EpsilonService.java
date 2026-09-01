package com.example.app.domain.security.application;

import java.util.UUID;
import com.example.app.domain.security.domain.Epsilon;

public interface EpsilonService {
	Epsilon findEpsilon(UUID epsilonId);
}
