export const JVM_FIXTURES = [
	{
		id: 'interface-mapping',
		path: 'fixtures/interface-mapping/Api.java',
		purpose: 'preserve interface inheritance and annotations without interpreting Spring semantics',
		expectedTopLevelTypes: ['WidgetApi', 'BaseApi', 'WidgetDto'],
		source: `package com.example.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;

@RequestMapping("/widgets")
public interface WidgetApi extends BaseApi<WidgetDto> {
    @GetMapping("/{id}")
    WidgetDto get(String id);
}

interface BaseApi<T> {}
record WidgetDto(String id) {}`,
	},
	{
		id: 'meta-annotation',
		path: 'fixtures/meta-annotation/ReadOnlyEndpoint.java',
		purpose: 'preserve composed annotation declarations and their own annotations',
		expectedTopLevelTypes: ['ReadOnlyEndpoint'],
		source: `package com.example.meta;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.lang.annotation.ElementType;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;

@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@RequestMapping(method = RequestMethod.GET)
public @interface ReadOnlyEndpoint {}`,
	},
	{
		id: 'record-generic',
		path: 'fixtures/record-generic/PageEnvelope.java',
		purpose: 'preserve nested generic record headers/components without resolving their types',
		expectedTopLevelTypes: ['PageEnvelope'],
		source: `package com.example.dto;

import java.util.List;
import java.util.Map;

public record PageEnvelope<T extends Comparable<T>>(
        List<T> items,
        Map<String, List<T>> grouped
) implements java.io.Serializable {}`,
	},
	{
		id: 'mapped-superclass-base',
		path: 'fixtures/mapped-superclass/BaseEntity.java',
		purpose: 'preserve mapped-superclass annotation, abstract modifier and generic declaration',
		expectedTopLevelTypes: ['BaseEntity'],
		source: `package com.example.domain;

import jakarta.persistence.Id;
import jakarta.persistence.MappedSuperclass;

@MappedSuperclass
public abstract class BaseEntity<ID> {
    @Id
    protected ID id;
}`,
	},
	{
		id: 'mapped-superclass-child',
		path: 'fixtures/mapped-superclass/Widget.java',
		purpose: 'preserve raw extends/implements facts without inferring inherited IDs',
		expectedTopLevelTypes: ['Widget', 'NamedEntity'],
		source: `package com.example.domain;

import jakarta.persistence.Entity;

@Entity
public final class Widget extends BaseEntity<java.util.UUID> implements NamedEntity {
    private String name;
}

interface NamedEntity {}`,
	},
	{
		id: 'multiple-top-level-types',
		path: 'fixtures/multi-top-level/Multi.java',
		purpose: 'keep multiple top-level declarations distinct while ignoring braces in comments/strings/chars',
		expectedTopLevelTypes: ['First', 'Second', 'Marker'],
		source: `package com.example.multi;

// Braces in comments and literals must not change top-level depth: { }
class First {
    char opening = '{';
    String brace = "}";
}

record Second(String value) {}

@interface Marker {}`,
	},
];

export function jvmFixture(id) {
	const fixture = JVM_FIXTURES.find((item) => item.id === id);
	if (!fixture) throw new Error(`unknown JVM fixture: ${id}`);
	return fixture;
}
