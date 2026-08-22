package com.backendskeleton.asthelper;

import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.ImportDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.RecordDeclaration;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.type.Type;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.CombinedTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.JavaParserTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.ReflectionTypeSolver;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * A2 Phase 2 (D-java-ast-helper): the real JavaParser + Symbol Solver analysis CATALOG.md's own
 * A2 entry names. Invoked only via handles/providers/java-spring/ast-bridge.mjs, only when a
 * human explicitly passes {@code --ast} to {@code bskel handles plan} -- never a hard dependency,
 * never invoked silently. Scope is deliberately narrow: DTO field type + annotation resolution
 * for a top-level {@code record} declaration, matching classifyDtoFields()'s own current scope
 * (patch-strategy.mjs) exactly -- a class-shaped DTO is an out-of-scope gap on BOTH the regex and
 * this AST path, not newly introduced here. Service-signature and security-expression resolution
 * (the other two surface areas CATALOG.md's A2 text names) are explicitly out of scope for this
 * item -- see D-java-ast-helper in DECISIONS.md.
 *
 * <p>Annotation names are resolved via the CompilationUnit's own import list (a plain name map),
 * deliberately NOT via JavaSymbolSolver's AnnotationExpr-specific resolution -- that API has a
 * documented history of unreliability (javaparser/javaparser#1621, a real ClassCastException with
 * no working fix in that thread). Field TYPES are resolved via the standard, reliably-documented
 * {@code Type#resolve()} Symbol Solver pattern instead, which has no comparable reliability
 * history -- this is what actually exercises CombinedTypeSolver/ReflectionTypeSolver/
 * JavaParserTypeSolver for real.
 *
 * <p>Every resolution attempt is wrapped so a single field's failure degrades to the as-written
 * text for THAT field only, never crashes the whole run -- an unusual generic shape or an
 * unresolvable third-party type must never take down analysis of the rest of the DTO.
 */
public final class Main {

	private Main() {
	}

	public static void main(String[] args) throws Exception {
		if (args.length < 2) {
			System.err.println("usage: Main <dto-file-path> <src-root>");
			System.exit(2);
		}
		String dtoFilePath = args[0];
		String srcRoot = args[1];

		CombinedTypeSolver typeSolver = new CombinedTypeSolver();
		typeSolver.add(new ReflectionTypeSolver());
		typeSolver.add(new JavaParserTypeSolver(new File(srcRoot)));
		// Found live: JavaParser's default configured language level does not support `record`
		// declarations (the exact DTO shape this helper exists to analyze) -- confirmed by a real
		// ParseProblemException before this line existed. Every generated resolver stub/patch DTO
		// this project's own oracle repos actually use is on a modern Spring Boot toolchain; JDK
		// 17 matches the java-compile fixture's own pinned toolchain elsewhere in this repo.
		StaticJavaParser.getParserConfiguration().setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_17);
		StaticJavaParser.getParserConfiguration().setSymbolResolver(new JavaSymbolSolver(typeSolver));

		CompilationUnit cu = StaticJavaParser.parse(Path.of(dtoFilePath));
		Optional<RecordDeclaration> recordDecl = cu.findFirst(RecordDeclaration.class);
		if (recordDecl.isEmpty()) {
			System.out.println("{\"recordName\":null,\"fields\":[],\"note\":\"no top-level record declaration found\"}");
			return;
		}
		RecordDeclaration decl = recordDecl.get();

		Map<String, String> importsBySimpleName = buildImportMap(cu);

		StringBuilder json = new StringBuilder();
		json.append("{\"recordName\":").append(jsonString(decl.getNameAsString())).append(",\"fields\":[");
		List<Parameter> components = decl.getParameters();
		for (int i = 0; i < components.size(); i++) {
			if (i > 0) json.append(',');
			appendField(json, components.get(i), importsBySimpleName);
		}
		json.append("]}");
		System.out.println(json);
	}

	/** Simple-name -> fully-qualified-name, from real (non-static, non-asterisk) imports only. */
	private static Map<String, String> buildImportMap(CompilationUnit cu) {
		Map<String, String> map = new HashMap<>();
		for (ImportDeclaration imp : cu.getImports()) {
			if (imp.isAsterisk() || imp.isStatic()) continue;
			String full = imp.getNameAsString();
			int lastDot = full.lastIndexOf('.');
			String simple = lastDot >= 0 ? full.substring(lastDot + 1) : full;
			map.put(simple, full);
		}
		return map;
	}

	private static void appendField(StringBuilder json, Parameter param, Map<String, String> importsBySimpleName) {
		String name = param.getNameAsString();
		Type type = param.getType();
		String rawType = type.asString();
		String resolvedType = resolveTypeSafely(type);

		json.append("{\"name\":").append(jsonString(name))
				.append(",\"rawType\":").append(jsonString(rawType))
				.append(",\"resolvedType\":").append(resolvedType == null ? "null" : jsonString(resolvedType))
				.append(",\"annotations\":[");
		List<AnnotationExpr> annotations = param.getAnnotations();
		for (int i = 0; i < annotations.size(); i++) {
			if (i > 0) json.append(',');
			appendAnnotation(json, annotations.get(i), importsBySimpleName);
		}
		json.append("]}");
	}

	/**
	 * Standard, reliable Symbol Solver pattern (type.resolve().describe()) -- this is what
	 * actually exercises CombinedTypeSolver against the real classpath. Any resolution failure
	 * (an unresolvable generic, a type outside the configured solvers) degrades to null for THIS
	 * field only -- the caller falls back to rawType, never crashes the run.
	 */
	private static String resolveTypeSafely(Type type) {
		try {
			return type.resolve().describe();
		} catch (Exception e) {
			return null;
		}
	}

	/**
	 * Deliberately NOT AnnotationExpr#resolve() (documented unreliable, see this class's own
	 * javadoc) -- a written-fully-qualified annotation (contains a dot) is already fully
	 * qualified in the AST with zero resolution needed; a simple-name annotation is looked up
	 * against this compilation unit's own real import list.
	 */
	private static void appendAnnotation(StringBuilder json, AnnotationExpr annotation, Map<String, String> importsBySimpleName) {
		String asWritten = annotation.getNameAsString();
		String resolvedFqn;
		if (asWritten.contains(".")) {
			resolvedFqn = asWritten;
		} else {
			resolvedFqn = importsBySimpleName.getOrDefault(asWritten, asWritten);
		}
		json.append("{\"asWritten\":").append(jsonString(asWritten))
				.append(",\"resolvedFqn\":").append(jsonString(resolvedFqn))
				.append('}');
	}

	private static String jsonString(String s) {
		StringBuilder sb = new StringBuilder("\"");
		for (int i = 0; i < s.length(); i++) {
			char c = s.charAt(i);
			switch (c) {
				case '"' -> sb.append("\\\"");
				case '\\' -> sb.append("\\\\");
				case '\n' -> sb.append("\\n");
				case '\r' -> sb.append("\\r");
				case '\t' -> sb.append("\\t");
				default -> {
					if (c < 0x20) {
						sb.append(String.format("\\u%04x", (int) c));
					} else {
						sb.append(c);
					}
				}
			}
		}
		sb.append('"');
		return sb.toString();
	}
}
