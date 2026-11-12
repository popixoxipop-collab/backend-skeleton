var app = builder.Build();
var dynamicGroup = app.MapGroup(prefix);
app.MapGet(prefix + "/todos", FindTodos);
app.MapMethods("/known-path", new[] { "GET", "POST" }, Dispatch);

[ApiController]
[Route(RouteNames.Todos)]
public class DynamicController : ControllerBase
{
    [HttpGet(RouteNames.ById)]
    public IActionResult Get(int id) => Ok(id);
}

[ApiController]
public class ConventionalController : ControllerBase
{
    [HttpPost]
    public IActionResult Create(object input) => Ok(input);
}
