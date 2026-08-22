package com.example.demo.domain.widget.domain;

import java.util.UUID;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Getter;
import lombok.Setter;

// O4 (D-handle-lifecycle): Getter/Setter added so this entity has a real read/write shape for
// WidgetServiceImpl -- Jackson's default visibility (PUBLIC_ONLY getters) also needs these to
// serialize this entity as anything but `{}` when HandleController#fetch/HandleAspect record it.
@Getter
@Setter
@Entity
@Table(name = "widgets")
public class Widget {

	@Id
	private UUID id;

	private String name;
}
