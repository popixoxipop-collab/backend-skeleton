using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("api/[controller]")]
public class TodoController : ControllerBase
{
    [HttpGet("{id}")]
    public IActionResult Get(int id) => Ok(id);

    [HttpPost("[action]")]
    public IActionResult Create(object input) => Ok(input);
}
