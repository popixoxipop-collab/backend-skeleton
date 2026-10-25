var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var api = app.MapGroup("/api");
var v1 = api.MapGroup("/v1");

v1.MapGet("/todos/{id}", (int id) => Results.Ok(id));
api.MapPost("/todos", (TodoDto todo) => Results.Created($"/api/todos/{todo.Id}", todo));

app.Run();
