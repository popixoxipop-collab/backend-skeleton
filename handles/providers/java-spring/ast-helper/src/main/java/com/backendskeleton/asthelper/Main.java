package com.backendskeleton.asthelper;

import com.github.javaparser.JavaParser;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ParseResult;
import com.github.javaparser.Problem;
import com.github.javaparser.Range;
import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.ImportDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.RecordDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.stmt.BlockStmt;
import com.github.javaparser.ast.type.Type;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.CombinedTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.JavaParserTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.ReflectionTypeSolver;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
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
		// D-java-source-splice: two new modes, dispatched on a literal args[0] match -- "locate" and
		// "parse" can never collide with a real DTO file path (relative or absolute paths always
		// contain a path separator or a file extension), so the pre-existing 2-positional-arg
		// classify invocation below is completely unaffected and untouched.
		if (args.length >= 1 && "locate".equals(args[0])) {
			runLocate(args);
			return;
		}
		if (args.length >= 2 && "parse".equals(args[0]) && "-".equals(args[1])) {
			runParse();
			return;
		}

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

	// ---------------------------------------------------------------------------------------
	// D-java-source-splice: "locate" mode -- the authoritative node locator for the new
	// java-source-splice patch kind. Resolves a method/field member inside a SINGLE top-level
	// type by its erased parameter-type signature (a real javac uniqueness rule, not a
	// heuristic -- two methods in one type can never share both a name and the same erased
	// parameter types). Reports every top-level type in the file so the Node-side caller can
	// refuse when the file declares more than one (V1 scope restriction, enforced on the Node
	// side, not here). Every field on a locate result is line/column, 1-based, INCLUSIVE on
	// both ends (JavaParser's own Range convention) -- the Node side converts to a byte offset
	// itself and self-validates by slicing the real file text and asserting it equals
	// regionText/signatureText exactly, so an offset-conversion bug here fails closed rather
	// than silently corrupting a splice.
	// ---------------------------------------------------------------------------------------

	private static void runLocate(String[] args) throws Exception {
		if (args.length < 4) {
			System.err.println("usage: Main locate <java-file> <src-root> <locators-file>");
			System.exit(2);
		}
		String javaFile = args[1];
		String srcRoot = args[2];
		String locatorsFile = args[3];

		List<Locator> locators = readLocators(locatorsFile);

		CombinedTypeSolver typeSolver = new CombinedTypeSolver();
		typeSolver.add(new ReflectionTypeSolver());
		typeSolver.add(new JavaParserTypeSolver(new File(srcRoot)));
		StaticJavaParser.getParserConfiguration().setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_17);
		StaticJavaParser.getParserConfiguration().setSymbolResolver(new JavaSymbolSolver(typeSolver));

		// Read the RAW file text separately from parsing it -- confirmed live, not assumed: JavaParser
		// Node#toString() invokes its own PrettyPrinter (default 4-space reformatting) rather than
		// returning literal source bytes. A first draft used body.toString() for regionText/
		// signatureText and it silently NORMALIZED the real file's tab indentation to spaces --
		// caught immediately by the Node-side self-validating offset check (D5, mechanism 2) refusing
		// with a "does not match" error, exactly the failure mode that check exists to catch. Every
		// regionText/signatureText below is now a real substring of `rawText`, sliced by Range, never
		// a re-printed node.
		String rawText = Files.readString(Path.of(javaFile), StandardCharsets.UTF_8);

		CompilationUnit cu = StaticJavaParser.parse(Path.of(javaFile));

		List<String> topLevelTypeNames = new ArrayList<>();
		for (TypeDeclaration<?> t : cu.getTypes()) {
			topLevelTypeNames.add(fqnOf(t));
		}

		StringBuilder json = new StringBuilder();
		json.append("{\"topLevelTypes\":[");
		for (int i = 0; i < topLevelTypeNames.size(); i++) {
			if (i > 0) json.append(',');
			json.append(jsonString(topLevelTypeNames.get(i)));
		}
		json.append("],\"results\":[");
		for (int i = 0; i < locators.size(); i++) {
			if (i > 0) json.append(',');
			appendLocateResult(json, cu, locators.get(i), rawText);
		}
		json.append("]}");
		System.out.println(json);
	}

	/**
	 * 1-based line, 1-based column (JavaParser's own Range convention, both ends INCLUSIVE) -> a
	 * real substring of `text`. The Node-side `lineColToOffset()` is the same algorithm,
	 * independently implemented -- this is the Java-side half of D5's mechanism 2 (the
	 * self-validating offset conversion), not a shared implementation, so a bug in one cannot
	 * silently agree with a matching bug in the other.
	 */
	private static String sliceByRange(String text, int beginLine, int beginColumn, int endLine, int endColumn) {
		int start = lineColToIndex(text, beginLine, beginColumn);
		int endInclusive = lineColToIndex(text, endLine, endColumn);
		return text.substring(start, endInclusive + 1);
	}

	private static int lineColToIndex(String text, int line, int column) {
		int idx = 0;
		int currentLine = 1;
		while (currentLine < line) {
			int nl = text.indexOf('\n', idx);
			if (nl < 0) throw new IllegalStateException("line " + line + " exceeds the file's actual line count");
			idx = nl + 1;
			currentLine++;
		}
		return idx + (column - 1);
	}

	private static String fqnOf(TypeDeclaration<?> t) {
		return t.getFullyQualifiedName().orElse(t.getNameAsString());
	}

	/** One locator request read from the locators file -- see readLocators() for the on-disk shape. */
	private static final class Locator {
		String typeFqn;
		String memberKind; // "method" | "field"
		String memberName;
		List<String> paramTypes; // method only; empty for field
	}

	/**
	 * Plain, delimiter-free line format (deliberately not JSON -- this helper has no JSON parser
	 * dependency, and this format needs none, since every field is a single line with no
	 * embedded newlines possible in a Java identifier/FQN):
	 * <pre>
	 * &lt;locator count N&gt;
	 * &lt;type_fqn&gt;
	 * &lt;member_kind&gt;
	 * &lt;member_name&gt;
	 * &lt;param count&gt;
	 * &lt;param type 1&gt;
	 * ...
	 * &lt;param type param-count&gt;
	 * (repeated N times)
	 * </pre>
	 */
	private static List<Locator> readLocators(String locatorsFile) throws Exception {
		List<String> lines = Files.readAllLines(Path.of(locatorsFile), StandardCharsets.UTF_8);
		List<Locator> out = new ArrayList<>();
		int i = 0;
		int count = Integer.parseInt(lines.get(i++).trim());
		for (int n = 0; n < count; n++) {
			Locator loc = new Locator();
			loc.typeFqn = lines.get(i++);
			loc.memberKind = lines.get(i++);
			loc.memberName = lines.get(i++);
			int paramCount = Integer.parseInt(lines.get(i++).trim());
			loc.paramTypes = new ArrayList<>();
			for (int p = 0; p < paramCount; p++) loc.paramTypes.add(lines.get(i++));
			out.add(loc);
		}
		return out;
	}

	/** Strips generic type arguments for an erasure-level comparison, e.g. "java.util.List<java.lang.String>" -> "java.util.List". Handles one level of nesting, sufficient for this kind's V1 scope (no nested-generic locator inputs are attempted). */
	private static String eraseGenerics(String describedType) {
		int lt = describedType.indexOf('<');
		return lt < 0 ? describedType : describedType.substring(0, lt);
	}

	private static void appendLocateResult(StringBuilder json, CompilationUnit cu, Locator loc, String rawText) {
		TypeDeclaration<?> target = null;
		for (TypeDeclaration<?> t : cu.getTypes()) {
			if (fqnOf(t).equals(loc.typeFqn)) {
				target = t;
				break;
			}
		}
		if (target == null) {
			appendUnresolved(json, "no top-level type named \"" + loc.typeFqn + "\" in this file");
			return;
		}

		if ("field".equals(loc.memberKind)) {
			appendFieldLocateResult(json, target, loc, rawText);
			return;
		}
		appendMethodLocateResult(json, target, loc, rawText);
	}

	private static void appendMethodLocateResult(StringBuilder json, TypeDeclaration<?> target, Locator loc, String rawText) {
		List<MethodDeclaration> candidates = new ArrayList<>();
		for (Object member : target.getMembers()) {
			if (member instanceof MethodDeclaration m && m.getNameAsString().equals(loc.memberName)) {
				candidates.add(m);
			}
		}
		if (candidates.isEmpty()) {
			appendUnresolved(json, "no method named \"" + loc.memberName + "\" in \"" + loc.typeFqn + "\"");
			return;
		}

		MethodDeclaration matched = null;
		List<String> matchedErased = null;
		List<String> matchedUnresolved = null;
		int matchCount = 0;
		for (MethodDeclaration m : candidates) {
			List<Parameter> params = m.getParameters();
			if (params.size() != loc.paramTypes.size()) continue;
			List<String> erased = new ArrayList<>();
			List<String> unresolved = new ArrayList<>();
			boolean allResolved = true;
			for (Parameter p : params) {
				try {
					erased.add(eraseGenerics(p.getType().resolve().describe()));
				} catch (Exception e) {
					erased.add(null);
					unresolved.add(p.getNameAsString());
					allResolved = false;
				}
			}
			if (!allResolved) continue; // an unresolved param can never be asserted to MATCH a request
			boolean paramsEqual = true;
			for (int k = 0; k < erased.size(); k++) {
				if (!erased.get(k).equals(loc.paramTypes.get(k))) {
					paramsEqual = false;
					break;
				}
			}
			if (paramsEqual) {
				matched = m;
				matchedErased = erased;
				matchedUnresolved = unresolved;
				matchCount++;
			}
		}

		if (matchCount == 0) {
			// Report the nearest miss for diagnostics: if there's exactly one same-name candidate,
			// show what its real (possibly unresolved) erased param types actually are.
			if (candidates.size() == 1) {
				MethodDeclaration only = candidates.get(0);
				List<String> unresolved = new ArrayList<>();
				List<String> erasedOrRaw = new ArrayList<>();
				for (Parameter p : only.getParameters()) {
					try {
						erasedOrRaw.add(eraseGenerics(p.getType().resolve().describe()));
					} catch (Exception e) {
						erasedOrRaw.add(p.getType().asString());
						unresolved.add(p.getNameAsString());
					}
				}
				appendUnresolved(json, "\"" + loc.memberName + "\" was found but its parameter types do not match the given locator", erasedOrRaw, unresolved);
			} else {
				appendUnresolved(json, "\"" + loc.memberName + "\" has " + candidates.size() + " overload(s) but none match the given locator's parameter types");
			}
			return;
		}
		if (matchCount > 1) {
			appendUnresolved(json, "\"" + loc.memberName + "\" locator matched " + matchCount + " overloads -- this should be impossible under javac's own erased-signature uniqueness rule; refusing rather than guessing");
			return;
		}

		Optional<BlockStmt> bodyOpt = matched.getBody();
		if (bodyOpt.isEmpty()) {
			appendUnresolved(json, "\"" + loc.memberName + "\" has no body (abstract/interface method) -- nothing to splice");
			return;
		}
		BlockStmt body = bodyOpt.get();
		Range bodyRange = body.getRange().orElseThrow();
		Range sigRange = signatureRange(matched.getRange().orElseThrow(), bodyRange);
		String regionText = sliceByRange(rawText, bodyRange.begin.line, bodyRange.begin.column, bodyRange.end.line, bodyRange.end.column);
		String signatureText = sliceByRange(rawText, sigRange.begin.line, sigRange.begin.column, sigRange.end.line, sigRange.end.column);

		json.append("{\"resolved\":true")
				.append(",\"beginLine\":").append(bodyRange.begin.line)
				.append(",\"beginColumn\":").append(bodyRange.begin.column)
				.append(",\"endLine\":").append(bodyRange.end.line)
				.append(",\"endColumn\":").append(bodyRange.end.column)
				.append(",\"regionText\":").append(jsonString(regionText))
				.append(",\"signatureBeginLine\":").append(sigRange.begin.line)
				.append(",\"signatureBeginColumn\":").append(sigRange.begin.column)
				.append(",\"signatureEndLine\":").append(sigRange.end.line)
				.append(",\"signatureEndColumn\":").append(sigRange.end.column)
				.append(",\"signatureText\":").append(jsonString(signatureText))
				.append(",\"erasedParamTypes\":[");
		for (int k = 0; k < matchedErased.size(); k++) {
			if (k > 0) json.append(',');
			json.append(jsonString(matchedErased.get(k)));
		}
		json.append("],\"unresolvedParamTypes\":[");
		for (int k = 0; k < matchedUnresolved.size(); k++) {
			if (k > 0) json.append(',');
			json.append(jsonString(matchedUnresolved.get(k)));
		}
		json.append("]}");
	}

	private static void appendFieldLocateResult(StringBuilder json, TypeDeclaration<?> target, Locator loc, String rawText) {
		FieldDeclaration matched = null;
		VariableDeclarator matchedVar = null;
		int candidateFieldGroups = 0;
		for (Object member : target.getMembers()) {
			if (!(member instanceof FieldDeclaration f)) continue;
			for (VariableDeclarator v : f.getVariables()) {
				if (v.getNameAsString().equals(loc.memberName)) {
					matched = f;
					matchedVar = v;
					candidateFieldGroups = f.getVariables().size();
				}
			}
		}
		if (matched == null) {
			appendUnresolved(json, "no field named \"" + loc.memberName + "\" in \"" + loc.typeFqn + "\"");
			return;
		}
		if (candidateFieldGroups != 1) {
			appendUnresolved(json, "field \"" + loc.memberName + "\" is declared in a multi-variable declaration (e.g. \"int a, b;\") -- not supported, split it into its own declaration first");
			return;
		}
		if (matchedVar.getInitializer().isEmpty()) {
			appendUnresolved(json, "field \"" + loc.memberName + "\" has no initializer to replace");
			return;
		}

		Range initRange = matchedVar.getInitializer().get().getRange().orElseThrow();
		Range sigRange = signatureRange(matched.getRange().orElseThrow(), initRange);
		String regionText = sliceByRange(rawText, initRange.begin.line, initRange.begin.column, initRange.end.line, initRange.end.column);
		String signatureText = sliceByRange(rawText, sigRange.begin.line, sigRange.begin.column, sigRange.end.line, sigRange.end.column);

		json.append("{\"resolved\":true")
				.append(",\"beginLine\":").append(initRange.begin.line)
				.append(",\"beginColumn\":").append(initRange.begin.column)
				.append(",\"endLine\":").append(initRange.end.line)
				.append(",\"endColumn\":").append(initRange.end.column)
				.append(",\"regionText\":").append(jsonString(regionText))
				.append(",\"signatureBeginLine\":").append(sigRange.begin.line)
				.append(",\"signatureBeginColumn\":").append(sigRange.begin.column)
				.append(",\"signatureEndLine\":").append(sigRange.end.line)
				.append(",\"signatureEndColumn\":").append(sigRange.end.column)
				.append(",\"signatureText\":").append(jsonString(signatureText))
				.append(",\"erasedParamTypes\":[],\"unresolvedParamTypes\":[]}");
	}

	/**
	 * [declBegin, memberEnd) where memberEnd is the position just before the body/initializer
	 * starts -- i.e. everything from the first annotation/modifier through (and including) the
	 * bytes right up to the opening brace or "=". Position has no left(int) (only right(int)),
	 * so this shifts back one column directly; the degenerate column<=1 case (the body/
	 * initializer starting at column 1 of a line, which real Java source essentially never does)
	 * clamps to column 1 rather than going invalid -- harmless, since the Node-side
	 * self-validation assertion (slice === signatureText) is the actual safety net either way.
	 */
	private static Range signatureRange(Range declRange, Range memberInnerRange) {
		com.github.javaparser.Position b = memberInnerRange.begin;
		com.github.javaparser.Position sigEnd = b.withColumn(Math.max(1, b.column - 1));
		return new Range(declRange.begin, sigEnd);
	}

	private static void appendUnresolved(StringBuilder json, String error) {
		appendUnresolved(json, error, List.of(), List.of());
	}

	private static void appendUnresolved(StringBuilder json, String error, List<String> erasedOrRaw, List<String> unresolved) {
		json.append("{\"resolved\":false,\"error\":").append(jsonString(error))
				.append(",\"erasedParamTypes\":[");
		for (int k = 0; k < erasedOrRaw.size(); k++) {
			if (k > 0) json.append(',');
			json.append(jsonString(erasedOrRaw.get(k)));
		}
		json.append("],\"unresolvedParamTypes\":[");
		for (int k = 0; k < unresolved.size(); k++) {
			if (k > 0) json.append(',');
			json.append(jsonString(unresolved.get(k)));
		}
		json.append("]}");
	}

	// ---------------------------------------------------------------------------------------
	// D-java-source-splice: "parse -" mode -- a plain syntax gate for a candidate rendered file,
	// read from stdin (build.gradle's `run { standardInput = System.in }` already wires this),
	// used at propose time on RENDERED content that has not been written to disk yet. Fresh,
	// solver-free JavaParser instance -- a syntax check needs no classpath/src-root at all.
	// ---------------------------------------------------------------------------------------

	private static void runParse() throws Exception {
		ByteArrayOutputStream buf = new ByteArrayOutputStream();
		try (BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
			int c;
			while ((c = reader.read()) != -1) buf.write(c);
		}
		String source = buf.toString(StandardCharsets.UTF_8);

		JavaParser parser = new JavaParser(new ParserConfiguration().setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_17));
		ParseResult<CompilationUnit> result = parser.parse(source);

		if (result.isSuccessful()) {
			System.out.println("{\"ok\":true}");
			return;
		}
		StringBuilder json = new StringBuilder("{\"ok\":false,\"problems\":[");
		List<Problem> problems = result.getProblems();
		for (int i = 0; i < problems.size(); i++) {
			if (i > 0) json.append(',');
			json.append(jsonString(problems.get(i).getVerboseMessage()));
		}
		json.append("]}");
		System.out.println(json);
	}
}
