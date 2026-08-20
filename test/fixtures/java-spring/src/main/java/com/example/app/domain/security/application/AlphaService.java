package com.example.app.domain.security.application;

import java.util.UUID;
import com.example.app.domain.security.domain.Alpha;

public interface AlphaService {
	Alpha findAlpha(UUID alphaId);
}
